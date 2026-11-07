import { assert, createCookieJar, login, withTestDb } from "../lib/harness.mjs";

export const name = "login throttling: admin unlock, old failures expire, a success resets the count";

const json = { "Content-Type": "application/json" };

async function attempt(baseUrl, username, password) {
  return fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: json, body: JSON.stringify({ username, password }) });
}

async function fail(baseUrl, username, times) {
  for (let i = 0; i < times; i += 1) {
    const response = await attempt(baseUrl, username, "wrong-password");
    assert(response.status === 401, `failure ${i + 1}: expected 401, got ${response.status}`);
  }
}

const row = (username) =>
  withTestDb(async (pool) => (await pool.query("SELECT failures, locked_until FROM login_attempts WHERE username_key = $1", [username])).rows[0]);

export async function run({ baseUrl }) {
  const admin = createCookieJar();
  await login(admin, baseUrl, "admin", "admin123");
  const created = await (await admin.fetch(`${baseUrl}/api/admin/users`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ username: "throttle_user", roles: ["student"] }),
  })).json();
  const { id, password } = created;
  assert(id && password, "create user");

  try {
    // Locked, then unlocked by an admin: the right password works at once.
    await fail(baseUrl, "throttle_user", 5);
    assert((await attempt(baseUrl, "throttle_user", password)).status === 429, "locked after 5 failures");
    const unlock = await admin.fetch(`${baseUrl}/api/admin/users/${id}/unlock`, { method: "POST" });
    assert(unlock.ok, `unlock ${unlock.status}`);
    assert((await attempt(baseUrl, "throttle_user", password)).ok, "signs in after unlock");
    const unknown = await admin.fetch(`${baseUrl}/api/admin/users/00000000-0000-4000-8000-000000000000/unlock`, { method: "POST" });
    assert(unknown.status === 404, `unlock unknown user: expected 404, got ${unknown.status}`);
    const student = createCookieJar();
    await login(student, baseUrl, "throttle_user", password);
    assert((await student.fetch(`${baseUrl}/api/admin/users/${id}/unlock`, { method: "POST" })).status === 403, "students cannot unlock");

    // Failures older than the window start the count again.
    await fail(baseUrl, "throttle_user", 4);
    await withTestDb((pool) => pool.query("UPDATE login_attempts SET last_failure_at = now() - interval '20 minutes' WHERE username_key = 'throttle_user'"));
    await fail(baseUrl, "throttle_user", 1);
    const restarted = await row("throttle_user");
    assert(restarted.failures === 1 && restarted.locked_until === null, `count after the window: ${JSON.stringify(restarted)}`);

    // A success clears the count: 4 + success + 4 failures is not a lock.
    await fail(baseUrl, "throttle_user", 3);
    assert((await attempt(baseUrl, "throttle_user", password)).ok, "success before the limit");
    assert((await row("throttle_user")) === undefined, "a success clears the counter");
    await fail(baseUrl, "throttle_user", 4);
    assert((await attempt(baseUrl, "throttle_user", password)).ok, "still signs in after 4 new failures");
  } finally {
    await withTestDb((pool) => pool.query("DELETE FROM login_attempts WHERE username_key = 'throttle_user'"));
  }
}
