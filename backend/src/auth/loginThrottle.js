import { getPool } from "../db/pool.js";

// Attempts are reserved BEFORE the password is checked, in one SQL statement,
// so parallel requests cannot all slip through to the hash check: the count
// is taken atomically and only the first few get to try a password.
//
// Two limits per login (fixed window of LOGIN_LOCK_MINUTES, started by the
// first attempt in it):
//   - one username from one client address: LOGIN_MAX_FAILURES (5). Past it,
//     that address is refused, even with the right password.
//   - one username from anywhere: LOGIN_MAX_FAILURES_PER_USER (20). This
//     bounds a guess spread over many addresses. Attempts from an address
//     that is already over its own limit are refused before they count here,
//     so one attacker address cannot use up the account's shared allowance
//     and lock the real user out; it takes 4+ addresses to do that.
// A successful login clears both counters. The WAF can only limit per IP;
// the per-username limit protects a single account from a distributed
// guessing attack. Changing the password is limited per user the same way
// (LOGIN_MAX_FAILURES attempts per window), since it checks the current one.
// `npm run db:unlock --workspace backend -- <username>` (or the admin
// "unlock" action) clears every counter for a name.
//
// The client address is req.ip, which is only trustworthy because the
// "trust proxy" setting in server.js lists exactly our own proxies
// (utils/trustedProxies.js).
function readInt(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function throttleSettings() {
  return {
    maxFailures: readInt("LOGIN_MAX_FAILURES", 5),
    maxFailuresPerUser: readInt("LOGIN_MAX_FAILURES_PER_USER", 20),
    lockSeconds: readInt("LOGIN_LOCK_MINUTES", 15) * 60,
  };
}

export function throttleKey(username) {
  return String(username ?? "").trim().toLowerCase().slice(0, 200);
}

function addressKey(ip) {
  return String(ip ?? "").slice(0, 64) || "unknown";
}

// Counts one attempt in a bucket (starting a new window if the last one is
// over) and returns the new count and the seconds left in the window.
// $1 username_key, $2 ip, $3 window seconds.
function bucketUpsert(select) {
  return `
    INSERT INTO login_throttle AS t (scope, username_key, ip, attempts, window_started_at)
    ${select}
    ON CONFLICT (scope, username_key, ip) DO UPDATE SET
      attempts = CASE WHEN t.window_started_at <= now() - make_interval(secs => $3::double precision)
                      THEN 1 ELSE t.attempts + 1 END,
      window_started_at = CASE WHEN t.window_started_at <= now() - make_interval(secs => $3::double precision)
                               THEN now() ELSE t.window_started_at END
    RETURNING t.attempts,
              GREATEST(1, CEIL(EXTRACT(EPOCH FROM (t.window_started_at
                + make_interval(secs => $3::double precision) - now())))::int) AS retry_seconds`;
}

async function forgetQuietNames(pool) {
  await pool.query(
    "DELETE FROM login_throttle WHERE window_started_at < now() - interval '1 day'",
  );
}

// Reserves one login attempt for this username from this address.
// Returns { allowed, retryAfterSeconds }; when not allowed, do not check the
// password.
export async function reserveLoginAttempt(username, ip, { pool = getPool() } = {}) {
  const { maxFailures, maxFailuresPerUser, lockSeconds } = throttleSettings();
  const result = await pool.query(
    `WITH ip_bucket AS (
       ${bucketUpsert("VALUES ('login_ip', $1::text, $2::text, 1, now())")}
     ), user_bucket AS (
       ${bucketUpsert("SELECT 'login_user', $1::text, '', 1, now() WHERE (SELECT attempts FROM ip_bucket) <= $4::int")}
     )
     SELECT (SELECT attempts FROM ip_bucket) AS ip_attempts,
            (SELECT retry_seconds FROM ip_bucket) AS ip_retry,
            (SELECT attempts FROM user_bucket) AS user_attempts,
            (SELECT retry_seconds FROM user_bucket) AS user_retry`,
    [throttleKey(username), addressKey(ip), lockSeconds, maxFailures],
  );
  const row = result.rows[0];
  await forgetQuietNames(pool);

  const ipBlocked = row.ip_attempts > maxFailures;
  const userBlocked = row.user_attempts !== null && row.user_attempts > maxFailuresPerUser;
  if (!ipBlocked && !userBlocked) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  return {
    allowed: false,
    retryAfterSeconds: Math.max(ipBlocked ? row.ip_retry : 0, userBlocked ? row.user_retry : 0),
  };
}

// Reserves one change-password attempt (the current password is checked).
export async function reservePasswordAttempt(username, { pool = getPool() } = {}) {
  const { maxFailures, lockSeconds } = throttleSettings();
  const result = await pool.query(
    bucketUpsert("VALUES ('password', $1::text, $2::text, 1, now())"),
    [throttleKey(username), "", lockSeconds],
  );
  const { attempts, retry_seconds: retrySeconds } = result.rows[0];
  await forgetQuietNames(pool);
  return attempts <= maxFailures
    ? { allowed: true, retryAfterSeconds: 0 }
    : { allowed: false, retryAfterSeconds: retrySeconds };
}

// After a successful login: forget this username's counters (its own address
// and the shared one).
export async function clearLoginAttempts(username, ip, { pool = getPool() } = {}) {
  await pool.query(
    `DELETE FROM login_throttle
     WHERE username_key = $1 AND (scope = 'login_user' OR (scope = 'login_ip' AND ip = $2))`,
    [throttleKey(username), addressKey(ip)],
  );
}

export async function clearPasswordAttempts(username, { pool = getPool() } = {}) {
  await pool.query("DELETE FROM login_throttle WHERE scope = 'password' AND username_key = $1", [
    throttleKey(username),
  ]);
}

// Admin unlock, password reset, db:unlock: every counter for the name.
export async function clearFailures(username, { pool = getPool() } = {}) {
  await pool.query("DELETE FROM login_throttle WHERE username_key = $1", [
    throttleKey(username),
  ]);
}
