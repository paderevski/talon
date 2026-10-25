import pg from "pg";
import { assert, testDatabaseUrl } from "../lib/harness.mjs";

export const name = "login throttling locks an account after repeated failures";

async function attempt(baseUrl, username, password) {
  return fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

export async function run({ baseUrl }) {
  // A real account nothing else in the suite signs in as, plus a name that does not exist.
  for (const username of ["student_a5", "nobody_by_that_name"]) {
    for (let i = 1; i <= 5; i += 1) {
      const response = await attempt(baseUrl, username, "wrong-password");
      assert(response.status === 401, `${username} failure ${i}: expected 401, got ${response.status}`);
    }

    // Locked: even the correct password is refused, with Retry-After.
    const locked = await attempt(baseUrl, username, "student123");
    assert(locked.status === 429, `${username}: expected 429 once locked, got ${locked.status}`);
    assert(Number(locked.headers.get("retry-after")) > 0, "Expected a Retry-After header");
    const body = await locked.json();
    assert(/try again/i.test(body.message), `Unexpected lock message: ${body.message}`);
  }

  // Locking one account does not affect another.
  const other = await attempt(baseUrl, "student_a4", "student123");
  assert(other.status === 200, `Other account should still sign in, got ${other.status}`);

  // Case-insensitive: changing the capitalization does not dodge the lock.
  const shouted = await attempt(baseUrl, "STUDENT_A5", "student123");
  assert(shouted.status === 429, `Expected 429 for different capitalization, got ${shouted.status}`);

  // After the lock passes (simulated), the correct password works and resets the counter.
  const pool = new pg.Pool({ connectionString: testDatabaseUrl });
  try {
    await pool.query("UPDATE login_attempts SET locked_until = now() - interval '1 second', last_failure_at = now() - interval '1 hour'");
    const ok = await attempt(baseUrl, "student_a5", "student123");
    assert(ok.status === 200, `Expected sign-in after the lock expired, got ${ok.status}`);
    const left = await pool.query("SELECT 1 FROM login_attempts WHERE username_key = 'student_a5'");
    assert(left.rowCount === 0, "Successful login should clear the failure counter");
    await pool.query("DELETE FROM login_attempts");
  } finally {
    await pool.end();
  }
}
