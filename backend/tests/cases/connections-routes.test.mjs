import { apiFetch, assert, createCookieJar, login, withTestDb } from "../lib/harness.mjs";

export const name = "connections: sign-in required, GitHub off when not configured, callback checks state (also at /api/github); jobs record their code source; admin unlink";

export async function run({ baseUrl }) {
  const anonymous = await fetch(`${baseUrl}/api/connections`);
  assert(anonymous.status === 401, `Expected anonymous 401, got ${anonymous.status}`);

  // The callback is a browser navigation: it redirects, never answers 401.
  // GitHub has /api/github/callback registered, so that path must keep working.
  for (const path of ["/api/github/callback", "/api/connections/github/callback"]) {
    const callback = await fetch(`${baseUrl}${path}?code=x&state=y`, { redirect: "manual" });
    const location = callback.headers.get("location") || "";
    assert(callback.status === 303, `${path}: expected redirect, got ${callback.status}`);
    assert(/connection=github&result=signed-out#connections$/.test(location), `${path}: anonymous callback went to ${location}`);
  }

  const jar = createCookieJar();
  await login(jar, baseUrl, "jane_smith", "talon123");
  const listed = await (await jar.fetch(`${baseUrl}/api/connections`)).json();
  const github = listed.items.find((item) => item.provider === "github");
  assert(github && github.configured === false && github.linked === false && github.account === null, `list ${JSON.stringify(listed)}`);
  assert(github.label === "GitHub" && github.roles.includes("code") && github.auth === "oauth", `github entry ${JSON.stringify(github)}`);

  const drive = listed.items.find((item) => item.provider === "google_drive");
  assert(drive && drive.label === "Google Drive" && drive.configured === false && drive.linked === false, `drive entry ${JSON.stringify(drive)}`);
  const picker = await jar.fetch(`${baseUrl}/api/connections/google_drive/picker`);
  assert(picker.status === 503, `picker without settings should be 503, got ${picker.status}`);
  const driveConnect = await jar.fetch(`${baseUrl}/api/connections/google_drive/connect`, { redirect: "manual" });
  assert(/connection=google_drive&result=not-configured/.test(driveConnect.headers.get("location") || ""), "drive connect without settings");
  assert((await fetch(`${baseUrl}/api/connections/google_drive/picker`)).status === 401, "picker needs sign-in");

  const one = await (await jar.fetch(`${baseUrl}/api/connections/github`)).json();
  assert(one.provider === "github" && one.linked === false, `single ${JSON.stringify(one)}`);
  assert((await jar.fetch(`${baseUrl}/api/connections/dropbox`)).status === 404, "unknown provider should be 404");

  const connect = await jar.fetch(`${baseUrl}/api/connections/github/connect`, { redirect: "manual" });
  assert(connect.status === 303 && /result=not-configured/.test(connect.headers.get("location") || ""), "connect without an app should say not-configured");

  // No state in the session (or a wrong one): refused before any GitHub call.
  const forged = await jar.fetch(`${baseUrl}/api/github/callback?code=attacker-code&state=guess`, { redirect: "manual" });
  assert(forged.status === 303 && /result=state/.test(forged.headers.get("location") || ""), `forged callback: ${forged.headers.get("location")}`);

  const items = await jar.fetch(`${baseUrl}/api/connections/github/items`);
  assert(items.status === 503, `Expected 503 for items without an app, got ${items.status}`);

  const unlink = await jar.fetch(`${baseUrl}/api/connections/github`, { method: "DELETE" });
  assert(unlink.ok, `Expected unlink 200, got ${unlink.status}`);

  // A submitted job keeps its code source: the type, the label lists show,
  // and the ref. Old-style top-level repo/branch and the new source object
  // mean the same thing; unknown source types are refused.
  const submit = (body) => apiFetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "source-test", entryScript: "x.py", ...body }),
  });
  const viaSource = await submit({ source: { type: "github", repo: "https://github.com/octocat/Hello-World", branch: "master" } });
  assert(viaSource.status === 201, `source object: expected 201, got ${viaSource.status}`);
  const { job } = await viaSource.json();
  assert(job.source.type === "github" && job.source.label === "octocat/Hello-World", `source ${JSON.stringify(job.source)}`);
  assert(job.source.ref.repo === "octocat/Hello-World" && job.source.ref.branch === "master" && job.source.ref.host === "github.com", `ref ${JSON.stringify(job.source.ref)}`);
  const legacy = await (await submit({ repo: "octocat/Hello-World", branch: "master" })).json();
  assert(legacy.job.source.type === "github" && legacy.job.source.ref.branch === "master", `legacy ${JSON.stringify(legacy.job?.source)}`);
  const unknown = await submit({ source: { type: "carrier-pigeon" } });
  assert(unknown.status === 400, `unknown source type should be 400, got ${unknown.status}`);
  const badBranch = await submit({ source: { type: "github", repo: "octocat/Hello-World", branch: "../x" } });
  assert(badBranch.status === 400, `bad branch should be 400, got ${badBranch.status}`);

  // Admin unlink: a linked row (token bytes are irrelevant here) is shown in
  // the user list and removed; only admins may do it.
  const janeId = await withTestDb(async (pool) => {
    const { rows } = await pool.query("SELECT id FROM users WHERE username = 'jane_smith'");
    await pool.query(
      `INSERT INTO connections (user_id, provider, external_id, external_login, key_id, iv, auth_tag, ciphertext)
       VALUES ($1, 'github', '5555', 'janehub', 'k1', '\\x00', '\\x00', '\\x00')`,
      [rows[0].id],
    );
    return rows[0].id;
  });
  const unlinkPath = `${baseUrl}/api/admin/users/${janeId}/connections/github`;
  const asStudent = await jar.fetch(unlinkPath, { method: "DELETE" });
  assert(asStudent.status === 403, `Student unlink should be 403, got ${asStudent.status}`);

  const admin = createCookieJar();
  await login(admin, baseUrl, "admin", "admin123");
  const users = await (await admin.fetch(`${baseUrl}/api/admin/users`)).json();
  const jane = users.users.find((u) => u.id === janeId);
  assert(jane?.githubLogin === "janehub" && jane.connections.some((c) => c.provider === "github" && c.login === "janehub"), "admin user list should show the GitHub login");
  const unlinked = await admin.fetch(unlinkPath, { method: "DELETE" });
  assert(unlinked.ok && (await unlinked.json()).login === "janehub", `admin unlink failed: ${unlinked.status}`);
  const again = await admin.fetch(unlinkPath, { method: "DELETE" });
  assert(again.status === 404, `Second unlink should be 404, got ${again.status}`);
  const unknownProvider = await admin.fetch(`${baseUrl}/api/admin/users/${janeId}/connections/dropbox`, { method: "DELETE" });
  assert(unknownProvider.status === 404, `unknown provider unlink should be 404, got ${unknownProvider.status}`);
  const remaining = await withTestDb(async (pool) => (await pool.query("SELECT count(*)::int AS n FROM connections WHERE user_id = $1", [janeId])).rows[0].n);
  assert(remaining === 0, "link row should be gone");
}
