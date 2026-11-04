import { assert, createCookieJar, login, withTestDb } from "../lib/harness.mjs";

export const name = "github app routes: sign-in required, off when not configured, callback checks state; admin unlink";

export async function run({ baseUrl }) {
  const anonymous = await fetch(`${baseUrl}/api/github`);
  assert(anonymous.status === 401, `Expected anonymous 401, got ${anonymous.status}`);

  // The callback is a browser navigation: it redirects, never answers 401.
  const anonymousCallback = await fetch(`${baseUrl}/api/github/callback?code=x&state=y`, { redirect: "manual" });
  assert(anonymousCallback.status === 303, `Expected callback redirect, got ${anonymousCallback.status}`);
  assert(/github=signed-out/.test(anonymousCallback.headers.get("location") || ""), "anonymous callback should say signed-out");

  const jar = createCookieJar();
  await login(jar, baseUrl, "jane_smith", "talon123");
  const status = await jar.fetch(`${baseUrl}/api/github`);
  assert(status.ok, `Expected status 200, got ${status.status}`);
  const payload = await status.json();
  assert(payload.configured === false && payload.linked === false && payload.login === "", `status ${JSON.stringify(payload)}`);

  const connect = await jar.fetch(`${baseUrl}/api/github/connect`, { redirect: "manual" });
  assert(connect.status === 303 && /github=not-configured/.test(connect.headers.get("location") || ""), "connect without an app should say not-configured");

  // No state in the session (or a wrong one): refused before any GitHub call.
  const forged = await jar.fetch(`${baseUrl}/api/github/callback?code=attacker-code&state=guess`, { redirect: "manual" });
  assert(forged.status === 303 && /github=state/.test(forged.headers.get("location") || ""), `forged callback: ${forged.headers.get("location")}`);

  const repos = await jar.fetch(`${baseUrl}/api/github/repos`);
  assert(repos.status === 503, `Expected 503 for repos without an app, got ${repos.status}`);

  const unlink = await jar.fetch(`${baseUrl}/api/github`, { method: "DELETE" });
  assert(unlink.ok, `Expected unlink 200, got ${unlink.status}`);

  const oldRoute = await jar.fetch(`${baseUrl}/api/github-credentials`);
  assert(oldRoute.status === 404, `PAT endpoint should be gone, got ${oldRoute.status}`);

  // Admin unlink: a linked row (token bytes are irrelevant here) is shown in
  // the user list and removed; only admins may do it.
  const janeId = await withTestDb(async (pool) => {
    const { rows } = await pool.query("SELECT id FROM users WHERE username = 'jane_smith'");
    await pool.query(
      `INSERT INTO github_accounts (user_id, github_user_id, github_login, key_id, iv, auth_tag, ciphertext)
       VALUES ($1, 5555, 'janehub', 'k1', '\\x00', '\\x00', '\\x00')`,
      [rows[0].id],
    );
    return rows[0].id;
  });
  const unlinkPath = `${baseUrl}/api/admin/users/${janeId}/github`;
  const asStudent = await jar.fetch(unlinkPath, { method: "DELETE" });
  assert(asStudent.status === 403, `Student unlink should be 403, got ${asStudent.status}`);

  const admin = createCookieJar();
  await login(admin, baseUrl, "admin", "admin123");
  const listed = await (await admin.fetch(`${baseUrl}/api/admin/users`)).json();
  assert(listed.users.find((u) => u.id === janeId)?.githubLogin === "janehub", "admin user list should show the GitHub login");
  const unlinked = await admin.fetch(unlinkPath, { method: "DELETE" });
  assert(unlinked.ok && (await unlinked.json()).githubLogin === "janehub", `admin unlink failed: ${unlinked.status}`);
  const again = await admin.fetch(unlinkPath, { method: "DELETE" });
  assert(again.status === 404, `Second unlink should be 404, got ${again.status}`);
  const remaining = await withTestDb(async (pool) => (await pool.query("SELECT count(*)::int AS n FROM github_accounts WHERE user_id = $1", [janeId])).rows[0].n);
  assert(remaining === 0, "link row should be gone");
}
