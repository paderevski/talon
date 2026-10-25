// Postgres repository tests. Uses a throwaway database (default talon_test),
// whose public schema is dropped and recreated on every run.
//   npm run test:postgres --workspace backend
import pg from "pg";
import { assert } from "../lib/harness.mjs";
import { runMigrations } from "../../src/db/migrate.js";
import { withTransaction } from "../../src/db/pool.js";
import { seedDemoUsers } from "../../src/db/seedDemo.js";
import { createUsersPostgresRepository } from "../../src/repositories/postgres/usersPostgresRepository.js";
import { createPasswordHash } from "../../src/utils/passwords.js";
import { BudgetError, ensureAccount, grant, transfer } from "../../src/budget/ledger.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL || "postgres://localhost/talon_test";

if (!/test/i.test(new URL(databaseUrl).pathname)) {
  throw new Error(`Refusing to reset non-test database ${databaseUrl}`);
}

const pool = new pg.Pool({ connectionString: databaseUrl });
const repo = createUsersPostgresRepository({ pool });

async function resetDatabase() {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await runMigrations(pool);
  await seedDemoUsers(pool);
}

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
];

let failed = 0;

try {
  await resetDatabase();
  console.log(`Running ${tests.length} Postgres test(s) on ${databaseUrl}`);

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
} finally {
  await pool.end();
}

console.log(failed ? `${failed} test(s) failed` : "All Postgres tests passed");
process.exitCode = failed ? 1 : 0;
