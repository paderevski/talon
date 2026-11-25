import { randomUUID } from "node:crypto";

// All functions take a pg client that is already inside a transaction
// (see withTransaction in db/pool.js). Amounts are integer cents.

export class BudgetError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "BudgetError";
    this.code = code;
  }
}

function assertPositiveCents(amountCents) {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new BudgetError(
      `Amount must be a positive whole number of cents, got ${amountCents}`,
      "invalid_amount",
    );
  }
}

export function dollarsToCents(dollars) {
  return Math.round(Number(dollars) * 100);
}

export function centsToDollars(cents) {
  return Number(cents) / 100;
}

export async function ensureAccount(client, ownerUserId, kind = "personal") {
  const result = await client.query(
    `
      INSERT INTO budget_accounts (owner_user_id, kind)
      VALUES ($1, $2)
      ON CONFLICT (owner_user_id, kind) DO UPDATE SET kind = EXCLUDED.kind
      RETURNING id
    `,
    [ownerUserId, kind],
  );
  return Number(result.rows[0].id);
}

// The one School account (no owner): the yearly budget is granted into it
// and everything else is funded by transfers out of it. Created on demand,
// since wiping a local or test database removes every account.
export async function ensureSchoolAccount(client) {
  const result = await client.query(
    `
      INSERT INTO budget_accounts (owner_user_id, kind)
      VALUES (NULL, 'school')
      ON CONFLICT (kind) WHERE kind = 'school' DO UPDATE SET kind = EXCLUDED.kind
      RETURNING id
    `,
  );
  return Number(result.rows[0].id);
}

// Locks accounts in id order so two concurrent transfers can't deadlock.
async function lockAccounts(client, accountIds) {
  const ids = [...new Set(accountIds)].sort((left, right) => left - right);
  const result = await client.query(
    `
      SELECT id, kind, balance_cents
      FROM budget_accounts
      WHERE id = ANY($1::bigint[])
      ORDER BY id
      FOR UPDATE
    `,
    [ids],
  );

  if (result.rows.length !== ids.length) {
    throw new BudgetError("Budget account not found", "account_not_found");
  }

  return new Map(
    result.rows.map((row) => [
      Number(row.id),
      { kind: row.kind, balanceCents: Number(row.balance_cents) },
    ]),
  );
}

async function postEntry(
  client,
  { accountId, amountCents, kind, transferId = null, jobId = null, note = null, createdBy = null },
) {
  await client.query(
    `
      INSERT INTO budget_ledger (account_id, amount_cents, kind, transfer_id, job_id, note, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [accountId, amountCents, kind, transferId, jobId, note, createdBy],
  );
  await client.query(
    "UPDATE budget_accounts SET balance_cents = balance_cents + $2 WHERE id = $1",
    [accountId, amountCents],
  );
}

// Money entering the system: only ever into the School account (the yearly
// budget). Everyone else is funded by a transfer from School.
export async function grant(client, { accountId, amountCents, note, createdBy }) {
  assertPositiveCents(amountCents);
  const accounts = await lockAccounts(client, [accountId]);
  if (accounts.get(accountId).kind !== "school") {
    throw new BudgetError("Money can only be granted into the School account", "not_school");
  }
  await postEntry(client, { accountId, amountCents, kind: "grant", note, createdBy });
}

// Admin takes money out of the School account (a correction: the yearly
// budget was smaller than granted). Never below zero; the removed money
// leaves the system. Other accounts give money back by a transfer to School.
export async function adjust(client, { accountId, amountCents, note, createdBy }) {
  if (!Number.isSafeInteger(amountCents) || amountCents >= 0) {
    throw new BudgetError(
      `Adjustment must be a negative whole number of cents, got ${amountCents}`,
      "invalid_amount",
    );
  }

  const accounts = await lockAccounts(client, [accountId]);
  if (accounts.get(accountId).kind !== "school") {
    throw new BudgetError("Money can only be removed from the School account", "not_school");
  }
  if (accounts.get(accountId).balanceCents + amountCents < 0) {
    throw new BudgetError("Cannot remove more than the current balance", "insufficient_funds");
  }

  await postEntry(client, { accountId, amountCents, kind: "adjustment", note, createdBy });
}

// Moves money between accounts (School -> pool, pool -> student, back again).
export async function transfer(
  client,
  { fromAccountId, toAccountId, amountCents, note, createdBy },
) {
  assertPositiveCents(amountCents);

  if (fromAccountId === toAccountId) {
    throw new BudgetError("Cannot transfer to the same account", "same_account");
  }

  const accounts = await lockAccounts(client, [fromAccountId, toAccountId]);
  const source = accounts.get(fromAccountId);

  if (source.balanceCents < amountCents) {
    throw new BudgetError("Insufficient funds in source account", "insufficient_funds");
  }

  const transferId = randomUUID();
  await postEntry(client, {
    accountId: fromAccountId,
    amountCents: -amountCents,
    kind: "transfer",
    transferId,
    note,
    createdBy,
  });
  await postEntry(client, {
    accountId: toAccountId,
    amountCents,
    kind: "transfer",
    transferId,
    note,
    createdBy,
  });

  return transferId;
}

// Job cost against a personal account. Never below zero (the database
// refuses too): EC2 jobs reserve their maximum cost up front, so a refund
// settles them; the local runner caps its charge (jobsPostgresRepository).
export async function charge(client, { accountId, amountCents, jobId, note, createdBy = null }) {
  assertPositiveCents(amountCents);
  const accounts = await lockAccounts(client, [accountId]);
  if (accounts.get(accountId).balanceCents < amountCents) {
    throw new BudgetError("Not enough budget left for this job", "insufficient_funds");
  }
  await postEntry(client, {
    accountId,
    amountCents: -amountCents,
    kind: "charge",
    jobId,
    note,
    createdBy,
  });
}

// Gives back the unused part of a job's reservation. A job gets at most one
// refund (enforced by a unique index).
export async function refund(client, { accountId, amountCents, jobId, note, createdBy = null }) {
  assertPositiveCents(amountCents);
  await lockAccounts(client, [accountId]);
  await postEntry(client, {
    accountId,
    amountCents,
    kind: "refund",
    jobId,
    note,
    createdBy,
  });
}
