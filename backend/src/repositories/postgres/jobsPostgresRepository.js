import { getPool, withTransaction } from "../../db/pool.js";
import { charge, ensureAccount } from "../../budget/ledger.js";
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
  async function finalize(jobId, { syncKey, status, durationSeconds, executionId = "", files = [], output = "Run output files", error = null, finalizedAt = null }) {
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
        if (costCents === 0) {
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

  return { list, findById, create, recordProgress, finalize, setHidden, listResults, personalBalanceCents };
}
