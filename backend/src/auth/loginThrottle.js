import { getPool } from "../db/pool.js";

// After LOGIN_MAX_FAILURES wrong passwords for one account name, further
// attempts (even with the right password) are refused for LOGIN_LOCK_MINUTES.
// The same number of minutes is the window failures are counted in, and a
// successful login clears the counter. The WAF can only limit per IP; this
// protects a single account from a distributed guessing attack.
// Trade-off: someone who knows a username can lock that account out for
// the lock period. `npm run db:unlock --workspace backend -- <username>`
// clears it early.
function readInt(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function throttleSettings() {
  return {
    maxFailures: readInt("LOGIN_MAX_FAILURES", 5),
    lockSeconds: readInt("LOGIN_LOCK_MINUTES", 15) * 60,
  };
}

export function throttleKey(username) {
  return String(username ?? "").trim().toLowerCase().slice(0, 200);
}

// Returns seconds remaining if the account is locked, otherwise 0.
export async function lockedSeconds(username, { pool = getPool() } = {}) {
  const result = await pool.query(
    `SELECT CEIL(EXTRACT(EPOCH FROM (locked_until - now())))::int AS seconds
     FROM login_attempts WHERE username_key = $1 AND locked_until > now()`,
    [throttleKey(username)],
  );
  return result.rows[0]?.seconds ?? 0;
}

export async function recordFailure(username, { pool = getPool() } = {}) {
  const { maxFailures, lockSeconds } = throttleSettings();
  const newCount = `(CASE WHEN login_attempts.last_failure_at < now() - make_interval(secs => $3)
                         THEN 1 ELSE login_attempts.failures + 1 END)`;
  await pool.query(
    `INSERT INTO login_attempts (username_key, failures, last_failure_at, locked_until)
     VALUES ($1, 1, now(), CASE WHEN 1 >= $2 THEN now() + make_interval(secs => $3) END)
     ON CONFLICT (username_key) DO UPDATE SET
       failures = ${newCount},
       last_failure_at = now(),
       locked_until = CASE WHEN ${newCount} >= $2
                           THEN now() + make_interval(secs => $3) END`,
    [throttleKey(username), maxFailures, lockSeconds],
  );
  // Housekeeping: forget names that have been quiet for a day.
  await pool.query(
    "DELETE FROM login_attempts WHERE last_failure_at < now() - interval '1 day'",
  );
}

export async function clearFailures(username, { pool = getPool() } = {}) {
  await pool.query("DELETE FROM login_attempts WHERE username_key = $1", [
    throttleKey(username),
  ]);
}
