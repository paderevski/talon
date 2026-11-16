import { assert, createCookieJar, insertTestJob, login, withTestDb } from "../lib/harness.mjs";

// Runs late (zz) because it adds admins and temporarily disables the others.
export const name = "last-admin guard, trimmed job JSON, generic file errors, strict archived flag";

const json = { "Content-Type": "application/json" };

async function send(jar, baseUrl, method, path, body) {
  const response = await jar.fetch(`${baseUrl}${path}`, {
    method,
    headers: json,
    body: body === undefined || method === "GET" ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

const activeAdmins = (pool) =>
  pool
    .query(
      `SELECT u.username FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role::text = 'admin'
       WHERE u.status = 'active' ORDER BY u.username`,
    )
    .then((result) => result.rows.map((row) => row.username));

export async function run({ baseUrl }) {
  const admin = createCookieJar();
  await login(admin, baseUrl, "admin", "admin123");

  // ---- PATCH /classes/:id: archived must be a real boolean
  const cls = await send(admin, baseUrl, "POST", "/api/admin/classes", { name: "Archive Flag", term: "2026-27", block: "AF1" });
  assert(cls.status === 201, `class create ${cls.status}`);
  const classUrl = `/api/admin/classes/${cls.payload.id}`;
  for (const archived of ["false", "true", 1, 0, null, "yes", {}]) {
    const response = await send(admin, baseUrl, "PATCH", classUrl, { archived });
    assert(response.status === 400, `archived ${JSON.stringify(archived)}: expected 400, got ${response.status}`);
  }
  const stillOpen = await withTestDb((pool) => pool.query("SELECT archived_at FROM classes WHERE id = $1", [cls.payload.id]));
  assert(stillOpen.rows[0].archived_at === null, "A rejected archived value must not archive the class");
  assert((await send(admin, baseUrl, "PATCH", classUrl, { archived: true })).status === 200, "archived true should work");
  assert((await send(admin, baseUrl, "PATCH", classUrl, { archived: false })).status === 200, "archived false should work");
  const reopened = await withTestDb((pool) => pool.query("SELECT archived_at FROM classes WHERE id = $1", [cls.payload.id]));
  assert(reopened.rows[0].archived_at === null, "archived false should reopen the class");

  // ---- Job JSON carries only what the UI reads of the execution reference
  const jobId = await withTestDb(async (pool) => {
    const id = await insertTestJob(pool, { owner: "student_a1", name: "trim-ref", status: "running", executionId: `trim-${Date.now()}` });
    await pool.query(`UPDATE jobs SET execution_provider = 'ec2', execution_ref = $2::jsonb WHERE id = $1`, [
      id,
      JSON.stringify({
        provider: "ec2",
        executionId: "exec-secret-id",
        s3Prefix: "jobs/secret-prefix",
        launchId: "launch-secret",
        instanceId: "i-0123456789abcdef0",
        instanceType: "t3.small",
        submittedAt: "2026-11-01T10:00:00.000Z",
        launchedAt: "2026-11-01T10:00:05.000Z",
      }),
    ]);
    return id;
  });
  const owner = createCookieJar();
  await login(owner, baseUrl, "student_a1", "student123");
  const checkRef = (job, who) => {
    const ref = job?.executionRef;
    assert(
      ref && ref.provider === "ec2" && ref.instanceType === "t3.small" && ref.instanceId && ref.launchedAt && ref.submittedAt,
      `${who}: UI fields missing from ${JSON.stringify(ref)}`,
    );
    for (const hidden of ["executionId", "s3Prefix", "launchId"]) {
      assert(!(hidden in ref), `${who}: executionRef still has ${hidden}`);
    }
  };
  for (const [jar, who] of [[owner, "owner"], [admin, "admin"]]) {
    const list = await send(jar, baseUrl, "GET", "/api/jobs?includeHidden=true");
    const item = list.payload.items?.find((entry) => entry.id === jobId);
    assert(item, `${who}: job missing from the list`);
    checkRef(item, `${who} list`);
  }
  const hideResponse = await send(owner, baseUrl, "DELETE", `/api/jobs/${jobId}`);
  assert(!/secret/.test(JSON.stringify(hideResponse.payload)), "hide response leaks execution details");
  const unhideResponse = await send(owner, baseUrl, "POST", `/api/jobs/${jobId}/unhide`);
  assert(!/secret/.test(JSON.stringify(unhideResponse.payload)), "unhide response leaks execution details");

  // ---- File, log and status failures answer generically (the S3 call fails here)
  for (const path of ["logs", "files", "files/download?name=a.txt", ""]) {
    const response = await owner.fetch(`${baseUrl}/api/jobs/${jobId}/${path}`);
    const text = await response.text();
    if (path === "") {
      assert(!/secret/.test(text), `status: leaked detail ${text}`);
    }
    // Here the EC2 adapter is off, so these answer with the server's own message.
    assert(response.status >= 400 && /^\{"message":"[^"]*"\}$/.test(text), `${path || "status"}: ${response.status} ${text}`);
    assert(!/secret|credential|AccessDenied|arn:|bucket/i.test(text), `${path || "status"}: leaked detail ${text}`);
  }
  const missingLocal = await withTestDb((pool) =>
    insertTestJob(pool, { owner: "student_a1", name: "no-file", status: "completed", executionId: `nofile-${Date.now()}` }),
  );
  const missing = await owner.fetch(`${baseUrl}/api/jobs/${missingLocal}/files/download?name=nope.txt`);
  const missingText = await missing.text();
  assert(missing.status === 404 && !missingText.includes("/"), `missing local file: ${missing.status} ${missingText}`);

  // ---- Last-admin guard
  const names = ["lastadmin_a", "lastadmin_b", "lastadmin_c"];
  const users = {};
  for (const username of names) {
    const created = await send(admin, baseUrl, "POST", "/api/admin/users", { username, roles: ["admin"] });
    assert(created.status === 201, `${username} create ${created.status}`);
    users[username] = { id: created.payload.id, password: created.payload.password, jar: createCookieJar() };
    await login(users[username].jar, baseUrl, username, created.payload.password);
  }
  // Leave only the three new admins active.
  const parked = await withTestDb(async (pool) => {
    const rows = (
      await pool.query(
        `SELECT u.id FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role::text = 'admin'
         WHERE u.status = 'active' AND u.username <> ALL($1)`,
        [names],
      )
    ).rows.map((row) => row.id);
    await pool.query("UPDATE users SET status = 'disabled' WHERE id = ANY($1)", [rows]);
    return rows;
  });
  try {
    const a = users.lastadmin_a;
    const b = users.lastadmin_b;
    const c = users.lastadmin_c;

    // Admins demoting and disabling each other at once must leave one.
    const crossed = await Promise.all([
      send(a.jar, baseUrl, "PATCH", `/api/admin/users/${b.id}`, { roles: ["teacher"] }),
      send(b.jar, baseUrl, "PATCH", `/api/admin/users/${a.id}`, { roles: ["teacher"] }),
      send(c.jar, baseUrl, "PATCH", `/api/admin/users/${a.id}`, { status: "disabled" }),
      send(c.jar, baseUrl, "PATCH", `/api/admin/users/${b.id}`, { status: "disabled" }),
    ]);
    assert(crossed.every((response) => response.status < 500), `unexpected 5xx: ${JSON.stringify(crossed)}`);
    const left = await withTestDb(activeAdmins);
    assert(left.length >= 1, `no active admin left after concurrent changes: ${JSON.stringify(crossed)}`);

    // Put all three back, then take them down one at a time.
    await withTestDb(async (pool) => {
      await pool.query("UPDATE users SET status = 'active' WHERE username = ANY($1)", [names]);
      await pool.query(
        `INSERT INTO user_roles (user_id, role) SELECT id, 'admin' FROM users WHERE username = ANY($1) ON CONFLICT DO NOTHING`,
        [names],
      );
    });
    // (Disabling revoked their sessions.)
    for (const username of names) {
      users[username].jar = createCookieJar();
      await login(users[username].jar, baseUrl, username, users[username].password);
    }
    const first = await send(a.jar, baseUrl, "PATCH", `/api/admin/users/${b.id}`, { roles: ["teacher"] });
    assert(first.status === 200, `demoting one of three admins: ${first.status} ${JSON.stringify(first.payload)}`);
    const second = await send(a.jar, baseUrl, "PATCH", `/api/admin/users/${c.id}`, { status: "disabled" });
    assert(second.status === 200, `disabling one of two admins: ${second.status} ${JSON.stringify(second.payload)}`);
    // a is now the only active admin.
    const demoteSelf = await send(a.jar, baseUrl, "PATCH", `/api/admin/users/${a.id}`, { roles: ["teacher"] });
    assert(
      demoteSelf.status === 409 && /at least one active admin/.test(demoteSelf.payload.message),
      `last admin demote: ${demoteSelf.status} ${JSON.stringify(demoteSelf.payload)}`,
    );
    const disableSelf = await send(a.jar, baseUrl, "PATCH", `/api/admin/users/${a.id}`, { status: "disabled" });
    assert(disableSelf.status === 409, `last admin disable: ${disableSelf.status}`);
    assert((await withTestDb(activeAdmins)).join() === "lastadmin_a", "lastadmin_a should be the only active admin");
    // Edits that keep the admin role still work.
    const rename = await send(a.jar, baseUrl, "PATCH", `/api/admin/users/${a.id}`, { fullName: "Last Admin", roles: ["admin", "teacher"] });
    assert(rename.status === 200, `harmless edit of the last admin: ${rename.status}`);
  } finally {
    await withTestDb((pool) => pool.query("UPDATE users SET status = 'active' WHERE id = ANY($1)", [parked]));
  }
}
