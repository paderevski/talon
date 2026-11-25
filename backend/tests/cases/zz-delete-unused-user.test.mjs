import { transfer } from "../../src/budget/ledger.js";
import { assert, createCookieJar, insertTestJob, login, withTestDb } from "../lib/harness.mjs";

export const name = "admin delete user: only never-used accounts (a starting grant at most), ledger stays consistent";

const json = { "Content-Type": "application/json" };

async function send(jar, baseUrl, method, path, body) {
  const response = await jar.fetch(`${baseUrl}${path}`, {
    method,
    headers: json,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json().catch(() => ({})) };
}

const ledgerIsConsistent = (pool) =>
  pool
    .query(
      `SELECT
         (SELECT COUNT(*) FROM budget_accounts a
           WHERE a.balance_cents <> COALESCE((SELECT SUM(amount_cents) FROM budget_ledger l WHERE l.account_id = a.id), 0))::int AS out_of_sync,
         (SELECT COUNT(*) FROM (SELECT transfer_id FROM budget_ledger WHERE transfer_id IS NOT NULL
            GROUP BY transfer_id HAVING SUM(amount_cents) <> 0 OR COUNT(*) <> 2) t)::int AS unbalanced`,
    )
    .then((result) => result.rows[0].out_of_sync === 0 && result.rows[0].unbalanced === 0);

export async function run({ baseUrl }) {
  const admin = createCookieJar();
  await login(admin, baseUrl, "admin", "admin123");
  const adminId = await withTestDb((pool) => pool.query("SELECT id FROM users WHERE username = 'admin'")).then((r) => r.rows[0].id);

  const make = async (username, roles) => {
    const created = await send(admin, baseUrl, "POST", "/api/admin/users", { username, roles });
    assert(created.status === 201, `create ${username}: ${created.status}`);
    return created.payload;
  };
  const del = (user) => send(admin, baseUrl, "DELETE", `/api/admin/users/${user.id}`);
  const exists = (user) =>
    withTestDb((pool) => pool.query("SELECT 1 FROM users WHERE id = $1", [user.id])).then((r) => r.rows.length === 1);
  const poolCents = (user) =>
    withTestDb((pool) =>
      pool.query("SELECT balance_cents::int AS c FROM budget_accounts WHERE owner_user_id = $1 AND kind = 'teacher_pool'", [user.id]),
    ).then((r) => r.rows[0].c);
  const refused = async (user, label, pattern) => {
    const response = await del(user);
    assert(response.status === 409, `${label}: expected 409, got ${response.status}`);
    assert(pattern.test(response.payload.message), `${label}: message ${response.payload.message}`);
    assert(await exists(user), `${label}: user must still exist`);
  };

  // ---- Unused account
  const plain = await make("del_plain", ["student"]);
  assert((await del(plain)).status === 200, "plain delete");
  assert(!(await exists(plain)), "plain user gone");

  // ---- Unused account with only a starting grant: deleted, ledger stays consistent
  // (from the School account; deleting gives it back to School).
  const schoolCents = () =>
    withTestDb((pool) => pool.query("SELECT balance_cents::int AS c FROM budget_accounts WHERE kind = 'school'")).then((r) => r.rows[0].c);
  const schoolBefore = await schoolCents();
  const granted = await make("del_granted", ["student"]);
  assert((await send(admin, baseUrl, "POST", "/api/admin/budget/adjustments", { userId: granted.id, target: "personal", direction: "increase", amount: 10 })).status === 201, "grant only");
  assert((await schoolCents()) === schoolBefore - 1000, "the starting budget comes from School");
  assert((await del(granted)).status === 200, "granted delete");
  assert(!(await exists(granted)), "granted user gone");
  assert((await schoolCents()) === schoolBefore, "deleting gives the starting budget back to School");
  assert(await withTestDb(ledgerIsConsistent), "balances must equal the ledger after deleting a granted user");

  // ---- A teacher's allocation is never rewritten: refused
  const teacher = await make("del_teacher_pool", ["teacher"]);
  const funded = await make("del_funded", ["student"]);
  const adjust = (user, target, amount) =>
    send(admin, baseUrl, "POST", "/api/admin/budget/adjustments", { userId: user.id, target, direction: "increase", amount });
  assert((await adjust(teacher, "pool", 50)).status === 201, "fund pool");
  assert((await adjust(funded, "personal", 10)).status === 201, "grant student");
  await withTestDb(async (pool) => {
    const accounts = await pool.query("SELECT id, owner_user_id, kind FROM budget_accounts WHERE owner_user_id = ANY($1::uuid[])", [
      [teacher.id, funded.id],
    ]);
    const idOf = (user, kind) => Number(accounts.rows.find((r) => r.owner_user_id === user.id && r.kind === kind).id);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await transfer(client, {
        fromAccountId: idOf(teacher, "teacher_pool"),
        toAccountId: idOf(funded, "personal"),
        amountCents: 1500,
        note: "alloc",
        createdBy: teacher.id,
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });
  assert((await poolCents(teacher)) === 3500, "pool after allocation");
  assert((await del(funded)).status === 409, "an account with a teacher's allocation is refused");
  assert(await exists(funded), "funded user kept");
  assert((await poolCents(teacher)) === 3500, "the teacher's pool is untouched");

  // ---- Refusals
  const withJob = await make("del_job", ["student"]);
  const jobId = await withTestDb((pool) =>
    insertTestJob(pool, { owner: "del_job", name: "j", status: "completed", executionId: `del-${Date.now()}` }),
  );
  await withTestDb((pool) => pool.query("UPDATE jobs SET hidden = true, hidden_at = now() WHERE id = $1", [jobId]));
  await refused(withJob, "jobs (hidden)", /submitted jobs.*Disable/i);

  const charged = await make("del_charged", ["student"]);
  await withTestDb(async (pool) => {
    const acct = await pool.query("SELECT id FROM budget_accounts WHERE owner_user_id = $1 AND kind = 'personal'", [charged.id]);
    // A starting grant, then a charge that spends it (balance back to 0;
    // no account may go below zero).
    await pool.query("INSERT INTO budget_ledger (account_id, amount_cents, kind, note) VALUES ($1, 25, 'grant', 'x')", [acct.rows[0].id]);
    await pool.query("INSERT INTO budget_ledger (account_id, amount_cents, kind, note) VALUES ($1, -25, 'charge', 'x')", [acct.rows[0].id]);
  });
  await refused(charged, "charge", /budget activity.*Disable/i);
  const kept = await withTestDb((pool) =>
    pool.query("SELECT COUNT(*)::int AS n FROM budget_ledger l JOIN budget_accounts a ON a.id = l.account_id WHERE a.owner_user_id = $1", [charged.id]),
  );
  assert(kept.rows[0].n === 2, "a refused delete must not touch the ledger");

  const connected = await make("del_connected", ["student"]);
  await withTestDb((pool) =>
    pool.query(
      `INSERT INTO connections (user_id, provider, external_id, external_login, key_id, iv, auth_tag, ciphertext)
       VALUES ($1, 'github', 'ext-del', 'del-login', 'k', '\\x00', '\\x00', '\\x00')`,
      [connected.id],
    ),
  );
  await refused(connected, "connection", /Disconnect it first/i);

  const teaches = await make("del_teaches", ["teacher"]);
  const cls = await send(admin, baseUrl, "POST", "/api/admin/classes", { name: "Del Class", block: "DC1", teacherId: teaches.id });
  assert(cls.status === 201, `class ${cls.status}`);
  await refused(teaches, "teacher", /teaches a class/i);

  const self = await send(admin, baseUrl, "DELETE", `/api/admin/users/${adminId}`);
  assert(self.status === 400 && /own account/i.test(self.payload.message), `self: ${self.status} ${self.payload.message}`);

  // The last-admin guard cannot fire over HTTP here (the caller is always
  // another active admin), so check the allowed case: a second admin deletes
  // an unused admin.
  const second = await make("del_admin2", ["admin"]);
  const secondJar = createCookieJar();
  await login(secondJar, baseUrl, "del_admin2", second.password);
  // With another active admin present, deleting an unused admin works.
  const spare = await make("del_admin3", ["admin"]);
  assert((await send(secondJar, baseUrl, "DELETE", `/api/admin/users/${spare.id}`)).status === 200, "unused admin deletes while another admin is active");

  assert((await send(admin, baseUrl, "DELETE", "/api/admin/users/00000000-0000-4000-8000-000000000000")).status === 404, "unknown user 404");

  // ---- Non-admin
  const student = createCookieJar();
  await login(student, baseUrl, "student_a1", "student123");
  const other = await make("del_target", ["student"]);
  const forbidden = await send(student, baseUrl, "DELETE", `/api/admin/users/${other.id}`);
  assert(forbidden.status === 403, `non-admin: expected 403, got ${forbidden.status}`);
  assert(await exists(other), "target must survive a non-admin attempt");
}
