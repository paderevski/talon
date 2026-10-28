import { getPool, withTransaction } from "../../db/pool.js";
import { BudgetError, charge, ensureAccount, refund } from "../../budget/ledger.js";
import {
  computeCostCents,
  formatCost,
  formatDuration,
  formatSubmitted,
} from "../../utils/jobFormat.js";

const jobSelect = `
  SELECT j.*, o.username AS owner_username, h.username AS hidden_by_username
  FROM jobs j
  JOIN users o ON o.id = j.owner_user_id
  LEFT JOIN users h ON h.id = j.hidden_by_user_id
`;

// The job shape the API and frontend have always used.
function mapJobRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    repo: row.repo,
    branch: row.branch,
    entryScript: row.entry_script,
    status: row.status,
    hidden: row.hidden,
    ownerUsername: row.owner_username,
    gpu: row.compute_type || "—",
    submitted: formatSubmitted(row.created_at),
    submittedAt: row.created_at.toISOString(),
    duration: formatDuration(row.duration_seconds),
    cost: formatCost(row.cost_cents),
    costCents: Number(row.cost_cents),
    maxRuntimeSeconds: row.max_runtime_seconds,
    reservedCents: Number(row.reserved_cents),
    executionProvider: row.execution_provider || undefined,
    executionRef: row.execution_ref || undefined,
    resultSyncKey: row.result_sync_key || undefined,
    hiddenAt: row.hidden_at ? row.hidden_at.toISOString() : undefined,
    hiddenBy: row.hidden_by_username || undefined,
    hiddenReason: row.hidden_reason || undefined,
  };
}

const resultSelect = `
  SELECT r.*, o.username AS owner_username
  FROM results r
  JOIN jobs j ON j.id = r.job_id
  JOIN users o ON o.id = j.owner_user_id
`;

function mapResultRow(row) {
  return {
    id: row.id,
    jobId: row.job_id,
    executionId: row.execution_id,
    ownerUsername: row.owner_username,
    name: row.name,
    status: row.status,
    repo: row.repo,
    duration: formatDuration(row.duration_seconds),
    output: row.output,
    files: row.files,
    error: row.error || undefined,
    finalizedAt: row.finalized_at ? row.finalized_at.toISOString() : null,
  };
}

// `scope` is { all: true } or { usernames: Set<lowercase username> }, as built
// by auth/access.js. Filtering happens in SQL.
function scopeParam(scope) {
  return scope?.all ? null : [...(scope?.usernames ?? [])];
}

// Too many unfinished jobs for this user, or for the whole system.
export class JobLimitError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "JobLimitError";
    this.code = code;
  }
}

export function createJobsPostgresRepository({ pool } = {}) {
  const db = () => pool ?? getPool();

  async function list(scope) {
    const result = await db().query(
      `${jobSelect}
       WHERE ($1::text[] IS NULL OR lower(o.username) = ANY($1))
       ORDER BY j.created_at DESC, j.id DESC`,
      [scopeParam(scope)],
    );
    return result.rows.map(mapJobRow);
  }

  async function findById(jobId) {
    const result = await db().query(`${jobSelect} WHERE j.id = $1`, [String(jobId ?? "")]);
    return mapJobRow(result.rows[0]);
  }

  async function create({
    ownerUserId,
    name,
    repo,
    branch = "main",
    entryScript = "train.py",
    status = "queued",
    executionProvider = null,
    executionRef = null,
    computeType = null,
    hourlyRateCents = 0,
    maxRuntimeSeconds = null,
  }) {
    const result = await db().query(
      `INSERT INTO jobs
         (owner_user_id, name, repo, branch, entry_script, status, execution_provider,
          execution_ref, compute_type, hourly_rate_cents, max_runtime_seconds)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        ownerUserId, name, repo, branch, entryScript, status, executionProvider,
        executionRef ? JSON.stringify(executionRef) : null,
        computeType, hourlyRateCents, maxRuntimeSeconds,
      ],
    );
    return findById(result.rows[0].id);
  }

  // Creates a job and reserves its maximum cost in one transaction: the
  // reserved amount is charged to the owner's personal budget now and the
  // unused part is refunded when the job is finalized. Throws a BudgetError
  // (code "insufficient_funds") when the balance does not cover it, unless
  // `enforceBalance` is false (admins), in which case the balance may go
  // negative.
  async function createWithReservation({
    ownerUserId,
    name,
    repo,
    branch = "main",
    entryScript = "train.py",
    executionProvider,
    computeType,
    hourlyRateCents,
    maxRuntimeSeconds,
    reserveCents,
    enforceBalance = true,
    maxUnfinishedPerUser = null, // null: no limit
    maxUnfinishedTotal = null,
  }) {
    const jobId = await withTransaction(
      async (client) => {
        // One launch at a time past this point, so two submits cannot both
        // slip under a limit.
        await client.query("SELECT pg_advisory_xact_lock(727001)");

        const unfinished = `execution_provider = $1 AND status IN ('queued', 'running')`;
        if (maxUnfinishedPerUser !== null) {
          const mine = await client.query(
            `SELECT count(*)::int AS n FROM jobs WHERE ${unfinished} AND owner_user_id = $2`,
            [executionProvider, ownerUserId],
          );
          if (mine.rows[0].n >= maxUnfinishedPerUser) {
            throw new JobLimitError(
              `You already have ${maxUnfinishedPerUser === 1 ? "a job" : `${maxUnfinishedPerUser} jobs`} running. Wait for it to finish or cancel it.`,
              "user_limit",
            );
          }
        }
        if (maxUnfinishedTotal !== null) {
          const all = await client.query(`SELECT count(*)::int AS n FROM jobs WHERE ${unfinished}`, [executionProvider]);
          if (all.rows[0].n >= maxUnfinishedTotal) {
            throw new JobLimitError("Talon is running as many jobs as it can right now. Try again in a few minutes.", "system_limit");
          }
        }

        const accountId = await ensureAccount(client, ownerUserId, "personal");

        if (enforceBalance) {
          const balance = await client.query(
            "SELECT balance_cents FROM budget_accounts WHERE id = $1 FOR UPDATE",
            [accountId],
          );
          if (Number(balance.rows[0].balance_cents) < reserveCents) {
            throw new BudgetError("Not enough budget left for this job", "insufficient_funds");
          }
        }

        const inserted = await client.query(
          `INSERT INTO jobs
             (owner_user_id, name, repo, branch, entry_script, status, execution_provider,
              compute_type, hourly_rate_cents, max_runtime_seconds, reserved_cents)
           VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7, $8, $9, $10)
           RETURNING id`,
          [
            ownerUserId, name, repo, branch, entryScript, executionProvider,
            computeType, hourlyRateCents, maxRuntimeSeconds, reserveCents,
          ],
        );
        const id = inserted.rows[0].id;
        await charge(client, { accountId, amountCents: reserveCents, jobId: id, note: `Reserved for job ${id}` });
        return id;
      },
      { pool: db() },
    );
    return findById(jobId);
  }

  // Saves where the job is running once it has launched.
  async function setExecutionRef(jobId, executionRef) {
    await db().query(
      "UPDATE jobs SET execution_ref = $2::jsonb, updated_at = now() WHERE id = $1",
      [jobId, JSON.stringify(executionRef)],
    );
    return findById(jobId);
  }

  // Jobs of one provider that have not finished yet (for the reconciler).
  async function listUnfinished(provider) {
    const result = await db().query(
      `${jobSelect}
       WHERE j.execution_provider = $1 AND j.status IN ('queued', 'running')
       ORDER BY j.created_at`,
      [provider],
    );
    return result.rows.map(mapJobRow);
  }

  // Status/duration while a job is running (or after a status change).
  async function recordProgress(jobId, { status, durationSeconds }) {
    await db().query(
      `UPDATE jobs
       SET status = $2, duration_seconds = COALESCE($3, duration_seconds), updated_at = now()
       WHERE id = $1 AND (status IS DISTINCT FROM $2 OR duration_seconds IS DISTINCT FROM COALESCE($3, duration_seconds))`,
      [jobId, status, durationSeconds ?? null],
    );
    return findById(jobId);
  }

  // A job reached a final state: store its result, set final status and
  // duration, and charge its cost to the owner's personal budget, all in one
  // transaction. Safe to call repeatedly or concurrently: the first call for a
  // given syncKey does the work, later ones return the job unchanged, and the
  // ledger allows only one charge per job.
  async function finalize(jobId, { syncKey, status, durationSeconds, executionId = "", files = [], output = "Run output files", error = null, finalizedAt = null, neverRan = false }) {
    await withTransaction(
      async (client) => {
        const found = await client.query(`${jobSelect} WHERE j.id = $1 FOR UPDATE OF j`, [jobId]);
        const job = found.rows[0];
        if (!job || job.result_sync_key === syncKey) {
          return;
        }

        await client.query(
          `INSERT INTO results
             (id, job_id, execution_id, name, repo, status, duration_seconds, output, files, error, finalized_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
           ON CONFLICT (job_id) DO UPDATE SET
             execution_id = EXCLUDED.execution_id, name = EXCLUDED.name, repo = EXCLUDED.repo,
             status = EXCLUDED.status, duration_seconds = EXCLUDED.duration_seconds,
             output = EXCLUDED.output, files = EXCLUDED.files, error = EXCLUDED.error,
             finalized_at = EXCLUDED.finalized_at, updated_at = now()`,
          [
            `result-${jobId}`, jobId, executionId, job.name, job.repo, status,
            durationSeconds ?? job.duration_seconds, output, JSON.stringify(files), error, finalizedAt,
          ],
        );

        let costCents = Number(job.cost_cents);
        const reservedCents = Number(job.reserved_cents);
        if (reservedCents > 0) {
          // Reserved at launch: keep what the run cost (never more than was
          // reserved) and give back the rest, once. A job that never ran gets
          // everything back.
          const alreadyRefunded = await client.query(
            "SELECT 1 FROM budget_ledger WHERE job_id = $1 AND kind = 'refund'",
            [jobId],
          );
          if (costCents === 0 && alreadyRefunded.rows.length === 0) {
            costCents = neverRan
              ? 0
              : Math.min(reservedCents, computeCostCents(durationSeconds ?? job.duration_seconds, job.hourly_rate_cents));
            const unusedCents = reservedCents - costCents;
            if (unusedCents > 0) {
              const accountId = await ensureAccount(client, job.owner_user_id, "personal");
              await refund(client, { accountId, amountCents: unusedCents, jobId, note: `Unused reservation for job ${jobId}` });
            }
          }
        } else if (costCents === 0) {
          costCents = computeCostCents(durationSeconds ?? job.duration_seconds, job.hourly_rate_cents);
          if (costCents > 0) {
            const accountId = await ensureAccount(client, job.owner_user_id, "personal");
            await charge(client, { accountId, amountCents: costCents, jobId, note: `Job ${jobId}` });
          }
        }

        await client.query(
          `UPDATE jobs
           SET status = $2, duration_seconds = COALESCE($3, duration_seconds),
               result_sync_key = $4, cost_cents = $5, updated_at = now()
           WHERE id = $1`,
          [jobId, status, durationSeconds ?? null, syncKey, costCents],
        );
      },
      { pool: db() },
    );
    return findById(jobId);
  }

  async function setHidden(jobId, { hidden, byUserId = null, reason = null }) {
    await db().query(
      `UPDATE jobs
       SET hidden = $2,
           hidden_at = CASE WHEN $2 THEN now() END,
           hidden_by_user_id = CASE WHEN $2 THEN $3::uuid END,
           hidden_reason = CASE WHEN $2 THEN $4 END,
           updated_at = now()
       WHERE id = $1`,
      [jobId, hidden, byUserId, reason],
    );
    return findById(jobId);
  }

  async function listResults(scope) {
    const result = await db().query(
      `${resultSelect}
       WHERE ($1::text[] IS NULL OR lower(o.username) = ANY($1))
       ORDER BY r.updated_at DESC, r.id DESC`,
      [scopeParam(scope)],
    );
    return result.rows.map(mapResultRow);
  }

  // Can this user start another job? Only enforced once jobs actually cost
  // money (an hourly rate above zero); a zero or negative balance blocks it.
  async function personalBalanceCents(userId) {
    const result = await db().query(
      "SELECT balance_cents FROM budget_accounts WHERE owner_user_id = $1 AND kind = 'personal'",
      [userId],
    );
    return result.rows.length ? Number(result.rows[0].balance_cents) : 0;
  }

  return { list, findById, create, createWithReservation, setExecutionRef, listUnfinished, recordProgress, finalize, setHidden, listResults, personalBalanceCents };
}
