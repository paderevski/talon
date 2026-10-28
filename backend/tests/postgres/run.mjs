// Postgres repository tests. Uses a throwaway database (default talon_test),
// whose public schema is dropped and recreated on every run.
//   npm run test:postgres --workspace backend
import pg from "pg";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
import { hourlyRateCentsFor, listInstanceOptions, reservationCentsFor } from "../../src/execution/ec2Rates.js";
import createEc2ExecutionAdapter, { assertEntryScript, buildRunScript } from "../../src/execution/adapters/ec2ExecutionAdapter.js";
import { JobLimitError } from "../../src/repositories/postgres/jobsPostgresRepository.js";
import { launchEc2Job, parseEnvironmentVariables } from "../../src/services/ec2Jobs.js";
import { createEc2Reconciler } from "../../src/services/ec2Reconciler.js";

const databaseUrl = testDatabaseUrl;

const pool = new pg.Pool({ connectionString: databaseUrl });
const repo = createUsersPostgresRepository({ pool });

const resetDatabase = () => resetTestDatabase(databaseUrl);

async function scalar(sql, params = []) {
  const result = await pool.query(sql, params);
  return Object.values(result.rows[0])[0];
}


// Fake AWS clients for the EC2 adapter: S3 is a map, EC2 records its calls.
function makeFakeAws({ instance = { state: "running" } } = {}) {
  const objects = new Map();
  const calls = [];
  let instanceState = instance;
  const noSuchKey = () => Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
  return {
    objects, calls,
    setInstance(next) { instanceState = next; },
    s3: {
      async send(command) {
        const name = command.constructor.name;
        const input = command.input;
        if (name === "PutObjectCommand") { objects.set(input.Key, String(input.Body)); return {}; }
        if (name === "GetObjectCommand") {
          if (!objects.has(input.Key)) throw noSuchKey();
          const text = objects.get(input.Key);
          return { Body: { transformToString: async () => text, text }, ContentLength: text.length };
        }
        if (name === "ListObjectsV2Command") {
          return { Contents: [...objects.keys()].filter((k) => k.startsWith(input.Prefix)).map((Key) => ({ Key, Size: objects.get(Key).length })), IsTruncated: false };
        }
        throw new Error(`unexpected s3 ${name}`);
      },
    },
    ec2: {
      async send(command) {
        const name = command.constructor.name;
        calls.push({ name, input: command.input });
        if (name === "RunInstancesCommand") {
          if (command.input.SubnetId === "subnet-full") throw Object.assign(new Error("no capacity"), { name: "InsufficientInstanceCapacity" });
          return { Instances: [{ InstanceId: "i-abc", LaunchTime: new Date("2026-01-01T00:00:00Z") }] };
        }
        if (name === "DescribeInstancesCommand") {
          return instanceState
            ? { Reservations: [{ Instances: [{ InstanceId: "i-abc", State: { Name: instanceState.state }, LaunchTime: new Date("2026-01-01T00:00:00Z") }] }] }
            : { Reservations: [] };
        }
        if (name === "TerminateInstancesCommand") return {};
        throw new Error(`unexpected ec2 ${name}`);
      },
    },
  };
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

  ["ec2 rates: overhead is added and the reservation covers limit plus boot allowance", async () => {
    assert(hourlyRateCentsFor("m7g.large") === 9.16, `m7g.large rate ${hourlyRateCentsFor("m7g.large")}`);
    // 9.16 c/h for (1800 + 300) s = 5.343 c -> 6 c
    assert(reservationCentsFor(9.16, 1800) === 6, `reservation ${reservationCentsFor(9.16, 1800)}`);
    let burstable = false;
    try { hourlyRateCentsFor("t4g.medium"); } catch { burstable = true; }
    assert(burstable, "burstable t4g types must not be offered");
    const option = listInstanceOptions().find((o) => o.instanceType === "m7g.large");
    assert(option.memoryGb === 8 && option.reserveCentsByRuntime[1800] === 6 && option.reserveCentsByRuntime[86400] > 200, `option ${JSON.stringify(option)}`);
    let refused = false;
    try { hourlyRateCentsFor("p5.48xlarge"); } catch { refused = true; }
    assert(refused, "unknown instance types must be refused");
  }],

  ["ec2 jobs: reserve at launch, refund the unused part once, ledger stays balanced", async () => {
    const jobs = createJobsPostgresRepository({ pool });
    const userId = await scalar("SELECT id FROM users WHERE username = 'student_a1'");
    const accountId = await withTransaction((client) => ensureAccount(client, userId, "personal"), { pool });
    const balance = async () => Number(await scalar("SELECT balance_cents FROM budget_accounts WHERE id = $1", [accountId]));
    await pool.query("UPDATE budget_accounts SET balance_cents = balance_cents + 1000 WHERE id = $1", [accountId]);
    await pool.query("INSERT INTO budget_ledger (account_id, amount_cents, kind, note) VALUES ($1, 1000, 'grant', 'test top-up')", [accountId]);
    const start = await balance();

    const job = await jobs.createWithReservation({
      ownerUserId: userId, name: "reserve-test", repo: "x/y", executionProvider: "ec2",
      computeType: "t4g.medium", hourlyRateCents: 360, maxRuntimeSeconds: 1800, reserveCents: 200,
    });
    assert(job.reservedCents === 200 && (await balance()) === start - 200, "reservation must be charged at creation");

    // Ran 10 minutes at 3.60 dollars/hour = 60c; 140c comes back. Repeats do nothing.
    const args = (key) => ({ syncKey: key, status: "completed", durationSeconds: 600 });
    await Promise.all([jobs.finalize(job.id, args("a")), jobs.finalize(job.id, args("a")), jobs.finalize(job.id, args("b"))]);
    const settled = await jobs.findById(job.id);
    assert(settled.costCents === 60, `cost ${settled.costCents}`);
    assert((await balance()) === start - 60, `balance moved ${start - (await balance())}`);
    assert(Number(await scalar("SELECT count(*) FROM budget_ledger WHERE job_id = $1 AND kind = 'refund'", [job.id])) === 1, "exactly one refund");
    assert(Number(await scalar("SELECT count(*) FROM budget_ledger WHERE job_id = $1 AND kind = 'charge'", [job.id])) === 1, "exactly one charge");

    // Cost never exceeds the reservation, even for a run that overran it.
    const long = await jobs.createWithReservation({
      ownerUserId: userId, name: "overrun-test", repo: "x/y", executionProvider: "ec2",
      hourlyRateCents: 360, maxRuntimeSeconds: 1800, reserveCents: 200,
    });
    await jobs.finalize(long.id, { syncKey: "a", status: "failed", durationSeconds: 7200 });
    assert((await jobs.findById(long.id)).costCents === 200, "cost must be capped at the reservation");
    assert(Number(await scalar("SELECT count(*) FROM budget_ledger WHERE job_id = $1 AND kind = 'refund'", [long.id])) === 0, "no refund when the whole reservation was used");

    // A job that never ran gets everything back.
    const never = await jobs.createWithReservation({
      ownerUserId: userId, name: "never-ran", repo: "x/y", executionProvider: "ec2",
      hourlyRateCents: 360, maxRuntimeSeconds: 1800, reserveCents: 200,
    });
    await jobs.finalize(never.id, { syncKey: "launch-failed", status: "failed", neverRan: true, error: "x" });
    assert((await jobs.findById(never.id)).costCents === 0, "never-ran job must cost nothing");
    assert((await balance()) === start - 60 - 200, `balance after all three: ${await balance()}`);
  }],

  ["ec2 jobs: not enough budget refuses the launch and creates nothing; admins may overdraw", async () => {
    const jobs = createJobsPostgresRepository({ pool });
    const userId = await scalar("SELECT id FROM users WHERE username = 'student_a1'");
    const before = await scalar("SELECT count(*) FROM jobs");
    let code = null;
    try {
      await jobs.createWithReservation({ ownerUserId: userId, name: "too-big", repo: "x/y", executionProvider: "ec2", hourlyRateCents: 360, maxRuntimeSeconds: 1800, reserveCents: 100000000 });
    } catch (error) {
      code = error instanceof BudgetError ? error.code : error.message;
    }
    assert(code === "insufficient_funds", `Expected insufficient_funds, got ${code}`);
    assert((await scalar("SELECT count(*) FROM jobs")) === before, "a refused launch must not leave a job");

    const admin = await scalar("SELECT id FROM users WHERE username = 'admin'");
    const adminJob = await jobs.createWithReservation({ ownerUserId: admin, name: "admin-run", repo: "x/y", executionProvider: "ec2", hourlyRateCents: 360, maxRuntimeSeconds: 1800, reserveCents: 5, enforceBalance: false });
    assert(adminJob.reservedCents === 5, "admin launch should be allowed without balance");
  }],

  ["ec2 jobs: a failed launch fails the job and refunds everything", async () => {
    const jobs = createJobsPostgresRepository({ pool });
    const userId = await scalar("SELECT id FROM users WHERE username = 'student_a1'");
    const accountId = await withTransaction((client) => ensureAccount(client, userId, "personal"), { pool });
    await pool.query("UPDATE budget_accounts SET balance_cents = balance_cents + 500 WHERE id = $1", [accountId]);
    await pool.query("INSERT INTO budget_ledger (account_id, amount_cents, kind, note) VALUES ($1, 500, 'grant', 'test top-up')", [accountId]);
    const balanceBefore = Number(await scalar("SELECT balance_cents FROM budget_accounts WHERE id = $1", [accountId]));
    const user = { id: userId, username: "student_a1" };

    let message = "";
    try {
      await launchEc2Job({
        jobsRepository: jobs, user, isAdmin: false, maxRuntimeSeconds: 1800,
        payload: { name: "fails", repo: "x/y", instanceType: "c7g.large" },
        adapter: { async start() { throw new Error("InsufficientInstanceCapacity"); } },
      });
    } catch (error) {
      message = error.message;
    }
    assert(/InsufficientInstanceCapacity/.test(message), `launch error ${message}`);
    const failed = (await jobs.list({ all: true })).find((j) => j.name === "fails");
    assert(failed && failed.status === "failed" && failed.costCents === 0, `failed job ${JSON.stringify(failed)}`);
    assert(Number(await scalar("SELECT balance_cents FROM budget_accounts WHERE id = $1", [accountId])) === balanceBefore, "full refund expected");

    const ok = await launchEc2Job({
      jobsRepository: jobs, user, isAdmin: false, maxRuntimeSeconds: 1800,
      payload: { name: "works", repo: "x/y", instanceType: "c7g.large" },
      adapter: { async start(spec) { return { provider: "ec2", executionId: spec.jobId, jobId: spec.jobId, instanceId: "i-1" }; } },
    });
    assert(ok.executionRef.instanceId === "i-1" && ok.reservedCents > 0 && ok.computeType === undefined, `launched job ${JSON.stringify(ok)}`);
  }],

  ["ec2 reconciler: terminates orphan, finished and overrun instances, leaves live ones", async () => {
    const jobs = createJobsPostgresRepository({ pool });
    const owner = await scalar("SELECT id FROM users WHERE username = 'admin'");
    const mk = async (name, extra = {}) => jobs.createWithReservation({
      ownerUserId: owner, name, repo: "x/y", executionProvider: "ec2", hourlyRateCents: 360,
      maxRuntimeSeconds: 100, reserveCents: 5, enforceBalance: false, ...extra,
    });
    const live = await mk("rec-live");
    const finished = await mk("rec-finished");
    await jobs.finalize(finished.id, { syncKey: "k", status: "completed", durationSeconds: 70 });
    const overrun = await mk("rec-overrun");

    const longAgo = new Date(Date.now() - 3600 * 1000).toISOString();
    const justNow = new Date().toISOString();
    const terminated = [];
    const reconciler = createEc2Reconciler({
      jobsRepository: jobs,
      adapter: {
        async listJobInstances() {
          return [
            { instanceId: "i-live", jobId: live.id, launchTime: justNow },
            { instanceId: "i-finished", jobId: finished.id, launchTime: justNow },
            { instanceId: "i-overrun", jobId: overrun.id, launchTime: longAgo },
            { instanceId: "i-orphan", jobId: "job-999999", launchTime: justNow },
            { instanceId: "i-untagged", jobId: null, launchTime: justNow },
          ];
        },
        async terminateInstance(id) { terminated.push(id); },
      },
      sync: async () => {},
      markLost: async () => {},
      log: { log() {}, error() {} },
    });
    await reconciler.tick();
    assert(terminated.sort().join() === "i-finished,i-orphan,i-overrun,i-untagged", `terminated ${terminated.sort()}`);
  }],

  ["ec2 adapter: launch uploads input, tags the instance, falls back to another subnet", async () => {
    const aws = makeFakeAws();
    const adapter = createEc2ExecutionAdapter({
      ec2: aws.ec2, s3: aws.s3,
      config: { bucket: "b", launchTemplateId: "lt-1", subnetIds: ["subnet-full", "subnet-ok"] },
      prepareInput: async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), "talon-test-"));
        await writeFile(path.join(dir, "repo.tgz"), "archive-bytes");
        return { workDir: dir, archive: path.join(dir, "repo.tgz") };
      },
      now: () => Date.parse("2026-01-01T00:00:05Z"),
    });
    const ref = await adapter.start({ jobId: "job-7", repo: "a/b", branch: "main", entryScript: "train.py", maxRuntimeSeconds: 600, instanceType: "c7g.large", ownerUsername: "admin" });
    assert(ref.instanceId === "i-abc" && ref.subnetId === "subnet-ok" && ref.executionId === "job-7", `ref ${JSON.stringify(ref)}`);
    assert(aws.objects.get("jobs/job-7/input/repo.tgz") === "archive-bytes", "repo.tgz not uploaded");
    assert(/exec python3 -u 'train.py'/.test(aws.objects.get("jobs/job-7/input/run.sh")), "run.sh not uploaded");
    const run = aws.calls.filter((c) => c.name === "RunInstancesCommand").at(-1).input;
    const tags = Object.fromEntries(run.TagSpecifications[0].Tags.map((t) => [t.Key, t.Value]));
    assert(tags.Project === "talon" && tags.Component === "job" && tags["talon-job"] === "job-7" && tags["talon-max-seconds"] === "600", `tags ${JSON.stringify(tags)}`);
    assert(run.InstanceType === "c7g.large" && run.ClientToken === "talon-job-7", "type or client token wrong");

    let refused = "";
    try { await adapter.start({ jobId: "job-8", instanceType: "p5.48xlarge", maxRuntimeSeconds: 60 }); } catch (e) { refused = e.message; }
    assert(/not allowed/.test(refused), `unknown type: ${refused}`);
  }],

  ["ec2 adapter: entry script and branch cannot inject shell", async () => {
    for (const bad of ["x.py; rm -rf /", "$(id).py", "../../etc/passwd", "a b.py", "'quote.py", "-rf"]) {
      let refused = false;
      try { assertEntryScript(bad); } catch { refused = true; }
      assert(refused, `entry script ${JSON.stringify(bad)} must be refused`);
    }
    assert(buildRunScript("a.py").includes("PYTHONUNBUFFERED=1"), "output must not be buffered");
    assert(buildRunScript("src/train_1.py").includes("python3 -u 'src/train_1.py'"), "plain paths must pass");
  }],

  ["ec2 adapter: status, logs, files and cancel come from S3 and the instance", async () => {
    const aws = makeFakeAws({ instance: { state: "pending" } });
    let clock = Date.parse("2026-01-01T00:01:00Z");
    const adapter = createEc2ExecutionAdapter({ ec2: aws.ec2, s3: aws.s3, config: { bucket: "b", launchTemplateId: "lt", subnetIds: ["s"] }, now: () => clock });
    const ref = { provider: "ec2", jobId: "job-9", executionId: "job-9", instanceId: "i-abc", maxRuntimeSeconds: 600, submittedAt: "2026-01-01T00:00:00Z", launchedAt: "2026-01-01T00:00:00Z" };

    assert((await adapter.getStatus(ref)).state === "queued", "pending instance is queued");
    aws.setInstance({ state: "running" });
    assert((await adapter.getStatus(ref)).state === "running", "running instance is running");

    aws.objects.set("jobs/job-9/logs/job.log", "line one\nline two\n");
    aws.objects.set("jobs/job-9/output/model.txt", "weights");
    const logs = await adapter.getLogs(ref, 1);
    assert(logs.lines.join() === "line two" && logs.nextCursor === 2, `logs ${JSON.stringify(logs)}`);
    aws.objects.set("jobs/job-9/changed/notes/result.csv", "a,b");
    const files = await adapter.listOutputFiles(ref);
    assert(
      files.length === 2 && files.some((f) => f.name === "model.txt" && f.source === "output_dir") && files.some((f) => f.name === "notes/result.csv" && f.source === "repo_changed"),
      `files ${JSON.stringify(files)}`,
    );

    aws.objects.set("jobs/job-9/status.json", JSON.stringify({ state: "succeeded", exit_code: 0, updated_at: "2026-01-01T00:05:00Z" }));
    const done = await adapter.getStatus(ref);
    assert(done.state === "completed" && done.endedAt === "2026-01-01T00:05:00Z" && done.exitCode === 0, `done ${JSON.stringify(done)}`);

    aws.objects.set("jobs/job-9/status.json", JSON.stringify({ state: "timeout", exit_code: 124, updated_at: "2026-01-01T00:10:00Z" }));
    assert((await adapter.getStatus(ref)).state === "failed", "timeout is a failure");

    // No result and past the limit plus grace: failed at the deadline, stable key.
    aws.objects.delete("jobs/job-9/status.json");
    clock = Date.parse("2026-01-01T02:00:00Z");
    const overrun = await adapter.getStatus(ref);
    assert(overrun.state === "failed" && overrun.endedAt === "2026-01-01T00:30:00.000Z" && overrun.syncKey === "overrun", `overrun ${JSON.stringify(overrun)}`);

    // Instance vanished with no result, long after launch.
    aws.setInstance(null);
    clock = Date.parse("2026-01-01T00:02:00Z") + 1;
    const young = { ...ref, submittedAt: "2026-01-01T00:00:00Z" };
    let missing = 0;
    try { await adapter.getStatus(young); } catch (e) { missing = e.status; }
    assert(missing === 404, "a vanished instance is a 404 (the job is marked lost)");

    aws.setInstance({ state: "running" });
    clock = Date.parse("2026-01-01T00:03:00Z");
    await adapter.cancel(ref);
    assert(aws.calls.some((c) => c.name === "TerminateInstancesCommand"), "cancel must terminate the instance");
    const cancelled = await adapter.getStatus(ref);
    assert(cancelled.state === "cancelled", `cancelled ${JSON.stringify(cancelled)}`);
  }],

  ["ec2 adapter: downloads honor the source and cannot escape the job prefix", async () => {
    const aws = makeFakeAws();
    const adapter = createEc2ExecutionAdapter({ ec2: aws.ec2, s3: aws.s3, config: { bucket: "b", launchTemplateId: "lt", subnetIds: ["s"] } });
    const ref = { provider: "ec2", jobId: "job-9", instanceId: "i-abc" };
    aws.objects.set("jobs/job-9/output/a.txt", "from output");
    aws.objects.set("jobs/job-9/changed/a.txt", "from repo");
    assert((await adapter.openOutputFile(ref, "a.txt", "output_dir")).stream.text === "from output", "output_dir source");
    assert((await adapter.openOutputFile(ref, "a.txt", "repo_changed")).stream.text === "from repo", "repo_changed source");
    let status = 0;
    try { await adapter.openOutputFile(ref, "../job-8/output/a.txt"); } catch (e) { status = e.status; }
    assert(status === 400, `path escape must be refused, got ${status}`);
  }],

  ["ec2 jobs: environment variables are validated and quoted into run.sh", async () => {
    const vars = parseEnvironmentVariables("BATCH_SIZE=32\n# comment\nNAME=it's a test\n\nEPOCHS=5");
    assert(vars.length === 3 && vars[1].value === "it's a test", `parsed ${JSON.stringify(vars)}`);
    const script = buildRunScript("train.py", vars);
    assert(script.includes("export BATCH_SIZE='32'") && script.includes("export NAME='it'\\''s a test'"), `script ${script}`);
    for (const bad of ["no equals sign", "1BAD=x", "A B=x", "PATH=/tmp", "LD_PRELOAD=/x", "TALON_OUTPUT_DIR=/x"]) {
      let refused = false;
      try { parseEnvironmentVariables(bad); } catch { refused = true; }
      assert(refused, `${JSON.stringify(bad)} must be refused`);
    }
    assert(buildRunScript("a.py", parseEnvironmentVariables("X=$(id)")).includes("export X='$(id)'"), "shell syntax in values must be inert");
  }],

  ["ec2 jobs: time limit must be one of the offered choices", async () => {
    const jobs = createJobsPostgresRepository({ pool });
    const userId = await scalar("SELECT id FROM users WHERE username = 'student_a1'");
    const user = { id: userId, username: "student_a1" };
    const adapter = { async start(spec) { return { provider: "ec2", executionId: spec.jobId, jobId: spec.jobId, instanceId: "i-1" }; } };
    for (const bad of [0, 59, 5000, 999999, "abc"]) {
      let status = 0;
      try { await launchEc2Job({ jobsRepository: jobs, adapter, user, isAdmin: true, payload: { name: "x", repo: "x/y", maxRuntimeSeconds: bad } }); } catch (e) { status = e.status; }
      assert(status === 400, `time limit ${bad} must be refused, got ${status}`);
    }
  }],

  ["ec2 jobs: one unfinished job per user, ten in total, admins exempt from the per-user cap", async () => {
    const jobs = createJobsPostgresRepository({ pool });
    const adapter = { async start(spec) { return { provider: "ec2", executionId: spec.jobId, jobId: spec.jobId, instanceId: `i-${spec.jobId}` }; } };
    const grantBudget = async (username) => {
      const id = await scalar("SELECT id FROM users WHERE username = $1", [username]);
      const accountId = await withTransaction((client) => ensureAccount(client, id, "personal"), { pool });
      await pool.query("UPDATE budget_accounts SET balance_cents = balance_cents + 5000 WHERE id = $1", [accountId]);
      await pool.query("INSERT INTO budget_ledger (account_id, amount_cents, kind, note) VALUES ($1, 5000, 'grant', 'test top-up')", [accountId]);
      return { id, username };
    };
    const finishAll = async () => {
      const open = await pool.query("SELECT id FROM jobs WHERE execution_provider = 'ec2' AND status IN ('queued', 'running')");
      for (const row of open.rows) {
        await jobs.finalize(row.id, { syncKey: "test-done", status: "failed", neverRan: true, error: "test cleanup" });
      }
    };
    await finishAll();
    const launch = (user, isAdmin = false) => launchEc2Job({ jobsRepository: jobs, adapter, user, isAdmin, payload: { name: "cap", repo: "x/y", instanceType: "c7g.large", maxRuntimeSeconds: 1800 } });

    // Parallel submits by one user: exactly one wins.
    const a1 = await grantBudget("student_a1");
    const results = await Promise.allSettled([launch(a1), launch(a1), launch(a1)]);
    assert(results.filter((r) => r.status === "fulfilled").length === 1, `parallel results ${results.map((r) => r.status)}`);
    const rejection = results.find((r) => r.status === "rejected").reason;
    assert(rejection instanceof JobLimitError && rejection.code === "user_limit", `rejection ${rejection}`);
    assert(Number(await scalar("SELECT count(*) FROM jobs WHERE owner_user_id = $1 AND status IN ('queued','running') AND execution_provider = 'ec2'", [a1.id])) === 1, "one unfinished job");

    // A refused submit costs nothing.
    const accountId = await withTransaction((client) => ensureAccount(client, a1.id, "personal"), { pool });
    const ledgerBefore = Number(await scalar("SELECT count(*) FROM budget_ledger WHERE account_id = $1", [accountId]));
    try { await launch(a1); } catch { /* expected */ }
    assert(Number(await scalar("SELECT count(*) FROM budget_ledger WHERE account_id = $1", [accountId])) === ledgerBefore, "a refused submit must not touch the ledger");

    // Finishing frees the slot.
    await finishAll();
    await launch(a1);

    // System-wide cap: fill to 10 with different users, the 11th is refused.
    const students = [];
    for (const name of ["student_a2", "student_a3", "student_b1", "student_b2", "student_b3", "student_c1", "student_c2", "student_c3"]) {
      const row = await pool.query("SELECT 1 FROM users WHERE username = $1", [name]);
      if (row.rows.length) students.push(await grantBudget(name));
    }
    for (const student of students) { try { await launch(student); } catch { break; } }
    const admin = { id: await scalar("SELECT id FROM users WHERE username = 'admin'"), username: "admin" };
    while (Number(await scalar("SELECT count(*) FROM jobs WHERE execution_provider = 'ec2' AND status IN ('queued','running')")) < 10) {
      await launch(admin, true);
    }
    let code = "";
    try { await launch(admin, true); } catch (e) { code = e.code; }
    assert(code === "system_limit", `Expected system_limit at 10 unfinished jobs, got ${code}`);
    await finishAll();
  }],

  ["jobs: seeded demo job costs match each student's ledger charges net of refunds", async () => {
    const mismatches = await pool.query(
      `SELECT u.username, COALESCE(j.cost, 0) AS jobs_cost, COALESCE(l.charged, 0) AS ledger_charged
       FROM users u
       JOIN user_roles r ON r.user_id = u.id AND r.role = 'student'
       LEFT JOIN (SELECT owner_user_id, SUM(cost_cents) AS cost FROM jobs GROUP BY owner_user_id) j ON j.owner_user_id = u.id
       LEFT JOIN (SELECT a.owner_user_id, -SUM(l.amount_cents) AS charged
                  FROM budget_ledger l JOIN budget_accounts a ON a.id = l.account_id
                  WHERE l.kind IN ('charge', 'refund') AND a.kind = 'personal' GROUP BY a.owner_user_id) l ON l.owner_user_id = u.id
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
