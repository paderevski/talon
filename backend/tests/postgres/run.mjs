// Postgres repository tests. Uses a throwaway database (default talon_test),
// whose public schema is dropped and recreated on every run.
//   npm run test:postgres --workspace backend
import pg from "pg";
import { assert, createCookieJar, login, resetTestDatabase, startBackendForTests, testDatabaseUrl } from "../lib/harness.mjs";
import { runMigrations } from "../../src/db/migrate.js";
import { withTransaction } from "../../src/db/pool.js";
import { seedDemoUsers } from "../../src/db/seedDemo.js";
import { createUsersPostgresRepository } from "../../src/repositories/postgres/usersPostgresRepository.js";
import { createPasswordHash } from "../../src/utils/passwords.js";
import { createJobsPostgresRepository } from "../../src/repositories/postgres/jobsPostgresRepository.js";
import { computeCostCents } from "../../src/utils/jobFormat.js";
import { createGithubCredentialsStore } from "../../src/utils/githubCredentialsStore.js";
import { BudgetError, ensureAccount, grant, transfer } from "../../src/budget/ledger.js";

const databaseUrl = testDatabaseUrl;

const pool = new pg.Pool({ connectionString: databaseUrl });
const repo = createUsersPostgresRepository({ pool });

const resetDatabase = () => resetTestDatabase(databaseUrl);

async function scalar(sql, params = []) {
  const result = await pool.query(sql, params);
  return Object.values(result.rows[0])[0];
}

const tests = [
  ["migrations are idempotent", async () => {
    const applied = await runMigrations(pool);
    assert(applied.length === 0, `Expected no new migrations, got ${applied}`);
  }],

  ["seed creates expected users and classes", async () => {
    const roster = await repo.listAdminRoster();
    assert(roster.stats.adminCount === 1, `admins ${roster.stats.adminCount}`);
    assert(roster.stats.teacherCount === 4, `teachers ${roster.stats.teacherCount}`);
    assert(roster.stats.studentCount === 16, `students ${roster.stats.studentCount}`);
    assert(roster.stats.classCount === 4, `classes ${roster.stats.classCount}`);
  }],

  ["seed refuses to run when non-demo users exist", async () => {
    await pool.query("INSERT INTO users (username, display_name) VALUES ('real.person@lcps.org', 'Real Person')");
    let refused = false;
    try {
      await seedDemoUsers(pool);
    } catch (error) {
      refused = /non-demo users/.test(error.message);
    }
    await pool.query("DELETE FROM users WHERE username = 'real.person@lcps.org'");
    assert(refused, "Expected seed to refuse");
  }],

  ["login: correct password returns user with id and roles", async () => {
    const user = await repo.findByCredentials("jane_smith", "talon123");
    assert(user, "Expected jane_smith to log in");
    assert(user.role === "student", `role ${user.role}`);
    assert(user.roles.join() === "student", `roles ${user.roles}`);
    assert(user.fullName === "Jane Smith", `fullName ${user.fullName}`);
    assert(/^[0-9a-f-]{36}$/.test(user.id), `id ${user.id}`);
  }],

  ["login: username is case-insensitive", async () => {
    assert(await repo.findByCredentials("Jane_Smith", "talon123"), "Expected login");
  }],

  ["login: wrong password and unknown user both return null", async () => {
    assert((await repo.findByCredentials("jane_smith", "nope")) === null, "wrong password");
    assert((await repo.findByCredentials("nobody", "talon123")) === null, "unknown user");
  }],

  ["login: disabled user is rejected", async () => {
    await pool.query("UPDATE users SET status = 'disabled' WHERE username = 'jane_smith'");
    const user = await repo.findByCredentials("jane_smith", "talon123");
    await pool.query("UPDATE users SET status = 'active' WHERE username = 'jane_smith'");
    assert(user === null, "Expected disabled user to be rejected");
  }],

  ["roles: a user can be teacher and admin", async () => {
    await pool.query(`
      INSERT INTO user_roles (user_id, role)
      SELECT id, 'admin' FROM users WHERE username = 'teacher_ada'
    `);
    const user = await repo.findByUsername("teacher_ada");
    await pool.query(`
      DELETE FROM user_roles WHERE role = 'admin'
        AND user_id = (SELECT id FROM users WHERE username = 'teacher_ada')
    `);
    assert(user.roles.join() === "teacher,admin", `roles ${user.roles}`);
    assert(user.role === "admin", `primary role ${user.role}`);
  }],

  ["teacher roster: own class students, budgets in dollars, pool balance", async () => {
    const roster = await repo.getTeacherRoster("teacher_ada");
    assert(roster.teacher.className === "ML Foundations A", `class ${roster.teacher.className}`);
    assert(roster.students.length === 5, `students ${roster.students.length}`);
    const avery = roster.students.find((student) => student.username === "student_a1");
    assert(avery.quota === 12 && avery.tokensRemaining === 11, `budget ${JSON.stringify(avery)}`);
    assert(roster.teacher.poolBalance === 40, `pool ${roster.teacher.poolBalance}`); // $100 - 5 x $12
  }],

  ["teacher roster: non-teacher gets null", async () => {
    assert((await repo.getTeacherRoster("jane_smith")) === null, "Expected null");
  }],

  ["admin roster: students grouped under their teacher", async () => {
    const roster = await repo.listAdminRoster();
    const legacy = roster.teachers.find((teacher) => teacher.username === "talon_user");
    assert(legacy.students.map((student) => student.username).join() === "jane_smith", "jane under talon_user");
    const jane = legacy.students[0];
    assert(jane.quota === 12 && jane.tokensRemaining === 8.4, `jane budget ${JSON.stringify(jane)}`);
  }],

  ["budget: cached balances always equal the ledger sum", async () => {
    const mismatches = await scalar(`
      SELECT COUNT(*)::int FROM budget_accounts a
      WHERE a.balance_cents <> COALESCE((SELECT SUM(amount_cents) FROM budget_ledger l WHERE l.account_id = a.id), 0)
    `);
    assert(mismatches === 0, `${mismatches} account(s) out of sync`);
  }],

  ["budget: transfers net to zero", async () => {
    const unbalanced = await scalar(`
      SELECT COUNT(*)::int FROM (
        SELECT transfer_id FROM budget_ledger WHERE transfer_id IS NOT NULL
        GROUP BY transfer_id HAVING SUM(amount_cents) <> 0 OR COUNT(*) <> 2
      ) t
    `);
    assert(unbalanced === 0, `${unbalanced} unbalanced transfer(s)`);
  }],

  ["budget: pool cannot be overdrawn and failed transfer changes nothing", async () => {
    const teacherId = await scalar("SELECT id FROM users WHERE username = 'teacher_ada'");
    const studentId = await scalar("SELECT id FROM users WHERE username = 'student_a1'");
    const before = await scalar("SELECT COUNT(*)::int FROM budget_ledger");

    let code = null;
    try {
      await withTransaction(async (client) => {
        const poolAccount = await ensureAccount(client, teacherId, "teacher_pool");
        const studentAccount = await ensureAccount(client, studentId, "personal");
        await transfer(client, { fromAccountId: poolAccount, toAccountId: studentAccount, amountCents: 40_01 });
      }, { pool });
    } catch (error) {
      code = error instanceof BudgetError ? error.code : error.message;
    }

    assert(code === "insufficient_funds", `Expected insufficient_funds, got ${code}`);
    assert((await scalar("SELECT COUNT(*)::int FROM budget_ledger")) === before, "ledger changed");
  }],

  ["budget: concurrent transfers from one pool never overdraw it", async () => {
    const teacherId = await scalar("SELECT id FROM users WHERE username = 'teacher_grace'");
    const studentIds = (await pool.query(`
      SELECT m.user_id FROM class_members m
      JOIN class_members t ON t.class_id = m.class_id AND t.user_id = $1
      WHERE m.member_role = 'student'
    `, [teacherId])).rows.map((row) => row.user_id);

    // Ten parallel $5 transfers; exactly floor(pool / $5) may succeed.
    const startingPoolCents = await scalar(
      "SELECT balance_cents::int FROM budget_accounts WHERE owner_user_id = $1 AND kind = 'teacher_pool'",
      [teacherId],
    );
    const expectedSuccesses = Math.min(10, Math.floor(startingPoolCents / 5_00));
    assert(expectedSuccesses > 0 && expectedSuccesses < 10, `pool ${startingPoolCents} doesn't exercise contention`);

    const attempts = Array.from({ length: 10 }, (_, index) =>
      withTransaction(async (client) => {
        const poolAccount = await ensureAccount(client, teacherId, "teacher_pool");
        const studentAccount = await ensureAccount(client, studentIds[index % studentIds.length], "personal");
        await transfer(client, { fromAccountId: poolAccount, toAccountId: studentAccount, amountCents: 5_00 });
      }, { pool }).then(() => "ok", (error) => error.code || error.message),
    );
    const outcomes = await Promise.all(attempts);
    const succeeded = outcomes.filter((outcome) => outcome === "ok").length;
    const poolBalance = await scalar(
      "SELECT balance_cents::int FROM budget_accounts WHERE owner_user_id = $1 AND kind = 'teacher_pool'",
      [teacherId],
    );

    assert(
      succeeded === expectedSuccesses,
      `Expected ${expectedSuccesses} successful transfers, got ${succeeded} (${outcomes})`,
    );
    assert(
      poolBalance === startingPoolCents - expectedSuccesses * 5_00,
      `Pool ${poolBalance} after starting at ${startingPoolCents}`,
    );
  }],

  ["budget: grant rejects non-integer or non-positive cents", async () => {
    const adminId = await scalar("SELECT id FROM users WHERE username = 'admin'");
    for (const amountCents of [0, -5, 1.5]) {
      let code = null;
      try {
        await withTransaction(async (client) => {
          const account = await ensureAccount(client, adminId, "personal");
          await grant(client, { accountId: account, amountCents });
        }, { pool });
      } catch (error) {
        code = error.code;
      }
      assert(code === "invalid_amount", `amount ${amountCents}: got ${code}`);
    }
  }],

  ["identities: password_hash required for local, forbidden for entra", async () => {
    const userId = await scalar("SELECT id FROM users WHERE username = 'admin'");
    const rejects = async (sql, params) => {
      try {
        await pool.query(sql, params);
        return false;
      } catch {
        return true;
      }
    };
    assert(
      await rejects("INSERT INTO user_identities (user_id, provider, subject) VALUES ($1, 'local', 'x')", [userId]),
      "local without hash accepted",
    );
    assert(
      await rejects(
        "INSERT INTO user_identities (user_id, provider, subject, password_hash) VALUES ($1, 'entra', 'oid-1', $2)",
        [userId, createPasswordHash("x")],
      ),
      "entra with hash accepted",
    );
  }],
  ["github credentials: token round-trips, is encrypted at rest, last4 kept", async () => {
    const store = createGithubCredentialsStore({ pool });
    const userId = await scalar("SELECT id FROM users WHERE username = 'jane_smith'");
    const token = "ghp_exampleTOKEN1234567890abcd";
    await store.saveGithubTokenForUser(userId, token, "janehub");

    assert((await store.getGithubTokenForUser(userId)) === token, "token did not round-trip");
    const status = await store.getGithubTokenStatusForUser(userId);
    assert(status.hasToken && status.tokenLast4 === "abcd" && status.githubUsername === "janehub", `status ${JSON.stringify(status)}`);

    const row = (await pool.query("SELECT * FROM github_credentials WHERE user_id = $1", [userId])).rows[0];
    assert(row.key_id === "k1", `key_id ${row.key_id}`);
    assert(!JSON.stringify(row).includes("exampleTOKEN"), "plaintext token found in the row");
    assert(!Buffer.from(row.ciphertext).toString("utf8").includes("exampleTOKEN"), "ciphertext contains the token");
  }],

  ["github credentials: a row copied to another user does not decrypt", async () => {
    const store = createGithubCredentialsStore({ pool });
    const jane = await scalar("SELECT id FROM users WHERE username = 'jane_smith'");
    const other = await scalar("SELECT id FROM users WHERE username = 'student_a1'");
    await pool.query(
      `INSERT INTO github_credentials (user_id, github_username, key_id, iv, auth_tag, ciphertext, token_last4)
       SELECT $2, github_username, key_id, iv, auth_tag, ciphertext, token_last4 FROM github_credentials WHERE user_id = $1`,
      [jane, other],
    );
    assert((await store.getGithubTokenForUser(other)) === "", "copied row must not decrypt for another user");
    assert((await store.getGithubTokenForUser(jane)).startsWith("ghp_"), "original row must still decrypt");
    await pool.query("DELETE FROM github_credentials WHERE user_id = $1", [other]);
  }],

  ["github credentials: username-only rows, delete keeps username, removed with the user", async () => {
    const store = createGithubCredentialsStore({ pool });
    const userId = await scalar("SELECT id FROM users WHERE username = 'student_a2'");
    await store.saveGithubUsernameForUser(userId, "a2hub");
    let status = await store.getGithubTokenStatusForUser(userId);
    assert(!status.hasToken && status.githubUsername === "a2hub", "username-only save failed");

    await store.saveGithubTokenForUser(userId, "ghp_secondTOKEN0000", "a2hub");
    await store.deleteGithubTokenForUser(userId);
    status = await store.getGithubTokenStatusForUser(userId);
    assert(!status.hasToken && status.githubUsername === "a2hub", "delete should keep the username");

    await store.saveGithubUsernameForUser(userId, "");
    assert((await scalar("SELECT count(*) FROM github_credentials WHERE user_id = $1", [userId])) === "0", "empty row should be removed");

    // Deleting the user deletes their credentials row.
    const tempId = await scalar("INSERT INTO users (username, display_name) VALUES ('cascade.test@lcps.org', 'Cascade Test') RETURNING id");
    await store.saveGithubTokenForUser(tempId, "ghp_cascadeTOKEN9999", "cascade");
    await pool.query("DELETE FROM users WHERE id = $1", [tempId]);
    assert((await scalar("SELECT count(*) FROM github_credentials WHERE user_id = $1", [tempId])) === "0", "credentials should be deleted with the user");
  }],

  ["github credentials: key rotation keeps tokens readable", async () => {
    const store = createGithubCredentialsStore({ pool });
    const userId = await scalar("SELECT id FROM users WHERE username = 'jane_smith'");
    const saved = { key: process.env.TALON_CREDENTIALS_KEY, id: process.env.TALON_CREDENTIALS_KEY_ID };

    try {
      process.env.TALON_CREDENTIALS_KEY = "old-test-secret";
      process.env.TALON_CREDENTIALS_KEY_ID = "old1";
      await store.saveGithubTokenForUser(userId, "ghp_rotateME12345678wxyz", "janehub");

      // New key becomes current; old key is only kept for decrypting.
      process.env.TALON_CREDENTIALS_KEY = "new-test-secret";
      process.env.TALON_CREDENTIALS_KEY_ID = "new2";
      process.env.TALON_CREDENTIALS_OLD_KEYS = "old1:old-test-secret";
      assert((await store.getGithubTokenForUser(userId)) === "ghp_rotateME12345678wxyz", "old key row unreadable after key change");

      // Without the old key listed, the row cannot be read (and nothing crashes).
      process.env.TALON_CREDENTIALS_OLD_KEYS = "";
      assert((await store.getGithubTokenForUser(userId)) === "", "row must be unreadable without its key");
      process.env.TALON_CREDENTIALS_OLD_KEYS = "old1:old-test-secret";

      const { execFileSync } = await import("node:child_process");
      const output = execFileSync("node", ["scripts/db-rotate-credentials-key.mjs"], {
        cwd: new URL("../..", import.meta.url).pathname,
        env: { ...process.env, DATABASE_URL: databaseUrl },
      }).toString();
      assert(/Rotated 1 token\(s\) to key id 'new2'; 0 failed/.test(output), `rotation output: ${output}`);

      process.env.TALON_CREDENTIALS_OLD_KEYS = "";
      assert((await store.getGithubTokenForUser(userId)) === "ghp_rotateME12345678wxyz", "token unreadable after rotation");
      assert((await scalar("SELECT key_id FROM github_credentials WHERE user_id = $1", [userId])) === "new2", "key id not updated");
    } finally {
      for (const [name, value] of [["TALON_CREDENTIALS_KEY", saved.key], ["TALON_CREDENTIALS_KEY_ID", saved.id]]) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
      delete process.env.TALON_CREDENTIALS_OLD_KEYS;
    }
  }],

  ["jobs: cost is per second with a 60 second minimum; zero rate is free", async () => {
    assert(computeCostCents(600, 600) === 100, "600s at 600c/h should cost 100c");
    assert(computeCostCents(10, 600) === 10, "10s should bill the 60s minimum (10c)");
    assert(computeCostCents(601, 600) === 101, "partial cents round up");
    assert(computeCostCents(3600, 0) === 0, "zero rate must be free");
    assert(computeCostCents(null, 600) === 0, "unknown duration must not charge");
  }],

  ["jobs: finalize charges the owner exactly once, even concurrently", async () => {
    const jobs = createJobsPostgresRepository({ pool });
    const studentId = await scalar("SELECT id FROM users WHERE username = 'student_a1'");
    const before = Number(await scalar("SELECT balance_cents FROM budget_accounts WHERE owner_user_id = $1 AND kind = 'personal'", [studentId]));

    const job = await jobs.create({ ownerUserId: studentId, name: "charge-test", repo: "x/y", hourlyRateCents: 600 });
    const finalizeArgs = (syncKey) => ({ syncKey, status: "completed", durationSeconds: 600, files: [{ name: "a.txt" }] });
    await Promise.all([
      ...Array.from({ length: 5 }, () => jobs.finalize(job.id, finalizeArgs("2026-01-01T00:00:00Z"))),
      ...Array.from({ length: 5 }, () => jobs.finalize(job.id, finalizeArgs("2026-01-01T00:00:01Z"))),
    ]);

    const after = Number(await scalar("SELECT balance_cents FROM budget_accounts WHERE owner_user_id = $1 AND kind = 'personal'", [studentId]));
    assert(before - after === 100, `Expected one 100c charge, balance moved ${before - after}`);
    assert(Number(await scalar("SELECT count(*) FROM budget_ledger WHERE job_id = $1 AND kind = 'charge'", [job.id])) === 1, "Expected exactly one ledger charge");
    assert(Number(await scalar("SELECT count(*) FROM results WHERE job_id = $1", [job.id])) === 1, "Expected exactly one result row");

    const stored = await jobs.findById(job.id);
    assert(stored.cost === "$1.00" && stored.status === "completed" && stored.duration === "10m 0s", `Unexpected job ${JSON.stringify(stored)}`);
  }],

  ["jobs: seeded demo job costs match each student's ledger charges", async () => {
    const mismatches = await pool.query(
      `SELECT u.username, COALESCE(j.cost, 0) AS jobs_cost, COALESCE(l.charged, 0) AS ledger_charged
       FROM users u
       JOIN user_roles r ON r.user_id = u.id AND r.role = 'student'
       LEFT JOIN (SELECT owner_user_id, SUM(cost_cents) AS cost FROM jobs GROUP BY owner_user_id) j ON j.owner_user_id = u.id
       LEFT JOIN (SELECT a.owner_user_id, -SUM(l.amount_cents) AS charged
                  FROM budget_ledger l JOIN budget_accounts a ON a.id = l.account_id
                  WHERE l.kind = 'charge' AND a.kind = 'personal' GROUP BY a.owner_user_id) l ON l.owner_user_id = u.id
       WHERE u.username <> 'student_a1' AND COALESCE(j.cost, 0) <> COALESCE(l.charged, 0)`,
    );
    assert(mismatches.rows.length === 0, `Cost/ledger mismatch: ${JSON.stringify(mismatches.rows.slice(0, 3))}`);
  }],

  ["jobs: scope filtering and hide/unhide record who did it", async () => {
    const jobs = createJobsPostgresRepository({ pool });
    const janeScope = { all: false, usernames: new Set(["jane_smith"]) };
    const janeJobs = await jobs.list(janeScope);
    assert(janeJobs.length > 0 && janeJobs.every((job) => job.ownerUsername === "jane_smith"), "scope must limit to the owner");
    assert((await jobs.list({ all: true })).length > janeJobs.length, "admin scope should see more");
    assert((await jobs.list({ all: false, usernames: new Set() })).length === 0, "empty scope sees nothing");

    const adminId = await scalar("SELECT id FROM users WHERE username = 'admin'");
    const hidden = await jobs.setHidden(janeJobs[0].id, { hidden: true, byUserId: adminId, reason: "test" });
    assert(hidden.hidden && hidden.hiddenBy === "admin" && hidden.hiddenReason === "test", "hide not recorded");
    const restored = await jobs.setHidden(janeJobs[0].id, { hidden: false });
    assert(!restored.hidden && !restored.hiddenBy, "unhide should clear who/why");
  }],

  ["teacher roster: one section per class, students listed under each", async () => {
    const teacherId = await scalar("SELECT id FROM users WHERE username = 'teacher_ada'");
    const studentId = await scalar("SELECT id FROM users WHERE username = 'student_a1'");
    const classId = await scalar("INSERT INTO classes (name, term) VALUES ('Second Period Robotics', '2026-27') RETURNING id");
    await pool.query("INSERT INTO class_members (class_id, user_id, member_role) VALUES ($1, $2, 'teacher'), ($1, $3, 'student')", [classId, teacherId, studentId]);

    const roster = await repo.getTeacherRoster("teacher_ada");
    assert(roster.classes.length === 2, `Expected 2 classes, got ${roster.classes.length}`);
    const second = roster.classes.find((item) => item.className === "Second Period Robotics");
    assert(second && second.students.length === 1 && second.students[0].username === "student_a1", "second class should list its one student");
    const first = roster.classes.find((item) => item.className !== "Second Period Robotics");
    assert(first.students.length === 5, `first class should still have 5 students, got ${first.students.length}`);
    assert(roster.students.length === 5, `flat list is distinct people, got ${roster.students.length}`);

    await pool.query("DELETE FROM classes WHERE id = $1", [classId]);
  }],

];

// HTTP tests against a real backend using the Postgres provider and
// Postgres session store. `server` is started after the repository tests.
let server = null;

const httpTests = [
  ["session: login stores a Postgres session and /me returns the uuid user", async () => {
    const jar = createCookieJar();
    const before = await scalar("SELECT COUNT(*)::int FROM sessions");
    const response = await login(jar, server.baseUrl, "student_a1", "student123");
    assert(response.ok, `login ${response.status}`);
    assert((await scalar("SELECT COUNT(*)::int FROM sessions")) === before + 1, "Expected one new session row");

    const me = await (await jar.fetch(`${server.baseUrl}/api/auth/me`)).json();
    assert(/^[0-9a-f-]{36}$/.test(me.user.id), `id ${me.user.id}`);
    assert(me.user.roles.join() === "student", `roles ${me.user.roles}`);

    const lastLogin = await scalar("SELECT last_login_at FROM users WHERE username = 'student_a1'");
    assert(lastLogin, "Expected last_login_at to be recorded");
  }],

  ["session: disabling a user ends their existing session", async () => {
    const jar = createCookieJar();
    await login(jar, server.baseUrl, "student_a2", "student123");
    await pool.query("UPDATE users SET status = 'disabled' WHERE username = 'student_a2'");
    const me = await jar.fetch(`${server.baseUrl}/api/auth/me`);
    await pool.query("UPDATE users SET status = 'active' WHERE username = 'student_a2'");
    assert(me.status === 401, `Expected 401 for disabled user, got ${me.status}`);
  }],

  ["session: logout deletes the session row", async () => {
    const jar = createCookieJar();
    await login(jar, server.baseUrl, "student_a3", "student123");
    const sid = decodeURIComponent(jar.get("talon.sid")).replace(/^s:/, "").split(".")[0];
    assert((await scalar("SELECT COUNT(*)::int FROM sessions WHERE sid = $1", [sid])) === 1, "session row missing");
    await jar.fetch(`${server.baseUrl}/api/auth/logout`, { method: "POST" });
    assert((await scalar("SELECT COUNT(*)::int FROM sessions WHERE sid = $1", [sid])) === 0, "session row not deleted");
  }],

  ["session: teacher+admin can use both admin and teacher routes", async () => {
    await pool.query(`INSERT INTO user_roles (user_id, role) SELECT id, 'admin' FROM users WHERE username = 'teacher_grace'`);
    const jar = createCookieJar();
    await login(jar, server.baseUrl, "teacher_grace", "teach123");
    const admin = await jar.fetch(`${server.baseUrl}/api/admin/roster`);
    const teacher = await jar.fetch(`${server.baseUrl}/api/teacher/students`);
    await pool.query(`DELETE FROM user_roles WHERE role = 'admin' AND user_id = (SELECT id FROM users WHERE username = 'teacher_grace')`);
    assert(admin.ok && teacher.ok, `admin ${admin.status}, teacher ${teacher.status}`);
  }],
];

httpTests.push(
  ["security: demo seed is refused in production without opt-in", async () => {
    const saved = { env: process.env.NODE_ENV, allow: process.env.TALON_ALLOW_DEMO_SEED };
    process.env.NODE_ENV = "production";
    delete process.env.TALON_ALLOW_DEMO_SEED;
    let message = "";
    try {
      await seedDemoUsers(pool);
    } catch (error) {
      message = error.message;
    } finally {
      process.env.NODE_ENV = saved.env;
      if (saved.allow !== undefined) process.env.TALON_ALLOW_DEMO_SEED = saved.allow;
    }
    assert(/Refusing to seed demo users/.test(message), `Expected refusal, got '${message}'`);
  }],

  ["security: teacher sees only their students' jobs (Postgres classes)", async () => {
    const student = createCookieJar();
    await login(student, server.baseUrl, "student_g1", "student123");
    const created = await student.fetch(`${server.baseUrl}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "g1-job", repo: "octocat/Hello-World" }),
    });
    const { job } = await created.json();

    const visibleTo = async (username, password) => {
      const jar = createCookieJar();
      await login(jar, server.baseUrl, username, password);
      const list = await (await jar.fetch(`${server.baseUrl}/api/jobs?status=all`)).json();
      return list.items.some((item) => item.id === job.id);
    };

    assert(await visibleTo("teacher_grace", "teach123"), "Grace should see her student's job");
    assert(!(await visibleTo("teacher_ada", "teach123")), "Ada must not see Grace's student's job");
    assert(!(await visibleTo("student_g2", "student123")), "Classmate must not see the job");
    assert(await visibleTo("admin", "admin123"), "Admin should see the job");
    await student.fetch(`${server.baseUrl}/api/jobs/${job.id}/cancel`, { method: "POST" });
  }],
);

let failed = 0;

try {
  await resetDatabase();
  console.log(`Running ${tests.length + httpTests.length} Postgres test(s) on ${databaseUrl}`);

  for (const [name, run] of tests) {
    const startedAt = Date.now();
    try {
      await run();
      console.log(`✓ ${name} (${Date.now() - startedAt}ms)`);
    } catch (error) {
      failed += 1;
      console.error(`✗ ${name}\n  ${error?.message || error}`);
    }
  }

  server = await startBackendForTests({
    reset: false,
  });
  for (const [name, run] of httpTests) {
    const startedAt = Date.now();
    try {
      await run();
      console.log(`✓ ${name} (${Date.now() - startedAt}ms)`);
    } catch (error) {
      failed += 1;
      console.error(`✗ ${name}\n  ${error?.message || error}`);
    }
  }
} finally {
  await server?.stop();
  await pool.end();
}

console.log(failed ? `${failed} test(s) failed` : "All Postgres tests passed");
process.exitCode = failed ? 1 : 0;
