// Postgres repository tests. Uses a throwaway database (default talon_test),
// whose public schema is dropped and recreated on every run.
//   npm run test:postgres --workspace backend
// Code under test logs job events; keep the test output to errors. The
// logger reads this when it writes, so setting it here is early enough.
process.env.TALON_LOG_LEVEL ??= "error";
import pg from "pg";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { assert, createCookieJar, login, resetTestDatabase, startBackendForTests, testDatabaseUrl, waitFor } from "../lib/harness.mjs";
import { runMigrations } from "../../src/db/migrate.js";
import { assertSecureDatabaseUrl, connectionConfig, databaseTransport, useMigrationRole, withTransaction } from "../../src/db/pool.js";
import { withTryAdvisoryLock } from "../../src/db/advisoryLock.js";
import { checkDatabase } from "../../src/db/health.js";
import { seedDemoUsers } from "../../src/db/seedDemo.js";
import { createUsersPostgresRepository } from "../../src/repositories/postgres/usersPostgresRepository.js";
import { createPasswordHash } from "../../src/utils/passwords.js";
import { createJobsPostgresRepository, justFinalized } from "../../src/repositories/postgres/jobsPostgresRepository.js";
import { computeCostCents } from "../../src/utils/jobFormat.js";
import { createGithubAccountsStore, GithubAccountInUseError } from "../../src/utils/githubAccountsStore.js";
import { createAppJwt, createGithubApp, normalizeSlug } from "../../src/services/githubApp.js";
import { describeCloneError, gitAuthEnv } from "../../src/execution/gitAuth.js";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { BudgetError, ensureAccount, grant, transfer } from "../../src/budget/ledger.js";
import { bootAllowanceSeconds, hourlyRateCentsFor, imageFor, isAllowedRuntime, listInstanceOptions, reservationCentsFor } from "../../src/execution/ec2Rates.js";
import createEc2ExecutionAdapter, { assertEntryScript, buildRunScript } from "../../src/execution/adapters/ec2ExecutionAdapter.js";
import { JobLimitError } from "../../src/repositories/postgres/jobsPostgresRepository.js";
import { launchEc2Job, parseEnvironmentVariables, startEc2Job } from "../../src/services/ec2Jobs.js";
import { parseScriptArgs } from "../../src/utils/scriptArgs.js";
import { createEc2Reconciler } from "../../src/services/ec2Reconciler.js";
import { createJobSync } from "../../src/services/jobSync.js";
import { createConnectionsStore, ConnectionInUseError } from "../../src/connections/store.js";
import { createConnectionRegistry } from "../../src/connections/registry.js";
import { createGoogleDriveProvider, driveScope, pickerAppId } from "../../src/connections/providers/googleDrive.js";
import { getSourceType, parseCodeSource, prepareCodeSnapshot, registerSource, resolveSourceAccess } from "../../src/sources/index.js";
import { createDriveClient, safeName } from "../../src/sources/fetchers/drive.js";
import { createDriveSource } from "../../src/sources/drive.js";
import createLocalExecutionAdapter from "../../src/execution/adapters/localExecutionAdapter.js";
import { checkTree, packSnapshot } from "../../src/sources/snapshot.js";
import { cloneInto } from "../../src/sources/fetchers/git.js";
import { jobLaunchPrefix, userHomePrefix, userPrefix } from "../../src/storage/keys.js";
import express from "express";
import session from "express-session";
import http from "node:http";
import { createRepoRouter } from "../../src/routes/repo.js";
import { createProviderRouter } from "../../src/routes/connections.js";
import { describeProvider } from "../../src/connections/registry.js";

const databaseUrl = testDatabaseUrl;

const pool = new pg.Pool({ connectionString: databaseUrl });
const repo = createUsersPostgresRepository({ pool });

const resetDatabase = () => resetTestDatabase(databaseUrl);

async function scalar(sql, params = []) {
  const result = await pool.query(sql, params);
  return Object.values(result.rows[0])[0];
}


// Fake GitHub for the GitHub App tests: routes are "METHOD /path" (path
// relative to api.github.com or github.com); unknown routes answer 404.
function makeFakeGithub(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const { pathname, search } = new URL(url);
    const key = `${init.method || "GET"} ${pathname}${search}`;
    const parseBody = (body) => {
      try {
        return JSON.parse(body);
      } catch {
        return Object.fromEntries(new URLSearchParams(body));
      }
    };
    calls.push({ key, auth: init.headers?.Authorization || "", body: init.body ? parseBody(init.body) : null });
    const route = routes[key] ?? { status: 404, data: { message: "Not Found" } };
    return new Response(JSON.stringify(route.data), { status: route.status, headers: { "Content-Type": "application/json" } });
  };
  return { fetch, calls };
}

// Fake Google for the Drive provider tests: routes are "METHOD host/path"
// (query ignored); a handler gets the parsed body and returns the JSON reply
// (__status sets the HTTP status).
function makeFakeGoogle(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const { host, pathname } = new URL(url);
    const key = `${init.method || "GET"} ${host}${pathname}`;
    const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : null;
    calls.push({ key, url, auth: init.headers?.Authorization || "", body });
    const handler = routes[key];
    const { __status = 200, ...data } = handler ? handler(body) : { __status: 404, error: "not_found" };
    const status = data.error && __status === 200 ? 400 : __status;
    return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  };
  return { fetch, calls };
}
// An in-memory Google Drive for the Drive client, provider and source tests.
// tree: { id: { name, mimeType?, parent, content? } }; folders have the
// folder mime type. Answers files.list (by parent), files.get and alt=media.
function makeFakeDrive(tree) {
  const folder = "application/vnd.google-apps.folder";
  const calls = [];
  const meta = (id) => {
    const f = tree[id];
    const content = f.content ?? "";
    return { id, name: f.name, mimeType: f.mimeType || "text/plain", size: f.mimeType === folder ? undefined : String(Buffer.byteLength(content)), md5Checksum: `md5-${id}`, modifiedTime: "2026-11-07T00:00:00Z", trashed: Boolean(f.trashed) };
  };
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  const fetch = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    const match = /^\/drive\/v3\/files(?:\/([^/]+))?$/.exec(u.pathname);
    if (!match) return json({ error: "nope" }, 404);
    if (!match[1]) {
      const parent = /^'(.+)' in parents/.exec(u.searchParams.get("q") || "")?.[1];
      const files = Object.keys(tree).filter((id) => tree[id].parent === parent && !tree[id].trashed).map(meta)
        .sort((a, b) => (a.mimeType === folder ? 0 : 1) - (b.mimeType === folder ? 0 : 1) || a.name.localeCompare(b.name));
      return json({ files });
    }
    const id = decodeURIComponent(match[1]);
    if (!tree[id]) return json({ error: { message: "not found" } }, 404);
    if (u.searchParams.get("alt") === "media") return new Response(tree[id].content ?? "", { status: 200 });
    return json(meta(id));
  };
  return { fetch, calls };
}
const driveFolderMime = "application/vnd.google-apps.folder";
const sampleDriveTree = () => ({
  rootFolder01: { name: "ML Club", mimeType: driveFolderMime, parent: "my-drive" },
  week3Folder1: { name: "week3", mimeType: driveFolderMime, parent: "rootFolder01" },
  cnnFolder001: { name: "cnn", mimeType: driveFolderMime, parent: "week3Folder1" },
  trainFile001: { name: "train.py", parent: "cnnFolder001", content: "print('hello from drive')\nopen('made.txt', 'w').write('x')\n" },
  reqsFile0001: { name: "requirements.txt", parent: "cnnFolder001", content: "" },
  dataFolder01: { name: "data", mimeType: driveFolderMime, parent: "cnnFolder001" },
  csvFile00001: { name: "a.csv", parent: "dataFolder01", content: "1,2\n" },
  slashFile001: { name: "odd/name.txt", parent: "dataFolder01", content: "s" },
  dupeFile0001: { name: "notes.txt", parent: "dataFolder01", content: "one" },
  dupeFile0002: { name: "notes.txt", parent: "dataFolder01", content: "two" },
  gdocFile0001: { name: "Plan", mimeType: "application/vnd.google-apps.document", parent: "cnnFolder001" },
  gitFolder001: { name: ".git", mimeType: driveFolderMime, parent: "cnnFolder001" },
  gitConfig001: { name: "config", parent: "gitFolder001", content: "[core]" },
  envFolder001: { name: "myenv", mimeType: driveFolderMime, parent: "cnnFolder001" },
  envCfg000001: { name: "pyvenv.cfg", parent: "envFolder001", content: "home = /usr" },
  envLib000001: { name: "lib.py", parent: "envFolder001", content: "x" },
  cacheFolder1: { name: "__pycache__", mimeType: driveFolderMime, parent: "cnnFolder001" },
  cacheFile001: { name: "a.pyc", parent: "cacheFolder1", content: "x" },
  spaceFolder1: { name: "ML 2026", mimeType: driveFolderMime, parent: "rootFolder01" },
  spaceFile001: { name: "train.py", parent: "spaceFolder1", content: "print(1)\n" },
  outside00001: { name: "secret.py", parent: "my-drive", content: "no" },
  singleFile01: { name: "solo.py", parent: "my-drive", content: "print('solo')\n" },
});

const driveStore = () => createConnectionsStore({ provider: "google_drive", tokenPurpose: "google-drive-tokens", pool });
const fakeGoogleSettings = () => ({ clientId: "client-1", clientSecret: "secret-1", pickerApiKey: "picker-key", projectNumber: "123456", publicUrl: "http://localhost:5173" });

let fakeGithubKey = null;
function fakeGithubConfig() {
  fakeGithubKey ??= generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  return { clientId: "Iv1.test", slug: "talon-test", clientSecret: "test-secret", publicUrl: "http://localhost:5173", privateKey: fakeGithubKey };
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
          if (command.input.SubnetId === "subnet-not-offered") throw Object.assign(new Error("type not in this zone"), { name: "Unsupported" });
          if (command.input.SubnetId === "subnet-denied") throw Object.assign(new Error("denied"), { name: "UnauthorizedOperation" });
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

// Serves an express app on a free local port; returns { baseUrl, close }.
async function serveApp(app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
}

// A personal account topped up by `cents` through the ledger (keeps the
// balance equal to the ledger sum). Returns { accountId, balance() }.
async function topUp(username, cents) {
  const userId = await scalar("SELECT id FROM users WHERE username = $1", [username]);
  const accountId = await withTransaction((client) => ensureAccount(client, userId, "personal"), { pool });
  await pool.query("UPDATE budget_accounts SET balance_cents = balance_cents + $2 WHERE id = $1", [accountId, cents]);
  await pool.query("INSERT INTO budget_ledger (account_id, amount_cents, kind, note) VALUES ($1, $2, 'grant', 'test top-up')", [accountId, cents]);
  return { userId, accountId, balance: async () => Number(await scalar("SELECT balance_cents FROM budget_accounts WHERE id = $1", [accountId])) };
}

const ledgerCount = async (jobId, kind) => Number(await scalar("SELECT count(*) FROM budget_ledger WHERE job_id = $1 AND kind = $2", [jobId, kind]));

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

  ["seed with replaceAll wipes non-demo users and seeds sections (deploy.sh default)", async () => {
    await pool.query("INSERT INTO users (username, display_name) VALUES ('real.person@lcps.org', 'Real Person')");
    await seedDemoUsers(pool, { replaceAll: true });
    assert((await scalar("SELECT COUNT(*)::int FROM users WHERE username = 'real.person@lcps.org'")) === 0,
      "Expected the non-demo user to be wiped");
    const unblocked = await scalar("SELECT COUNT(*)::int FROM classes WHERE block IS NULL OR teacher_id IS NULL");
    assert(unblocked === 0, `Expected every seeded class to have a block and a teacher, ${unblocked} do not`);
  }],

  ["seed refuses while an EC2 job is queued or running, unless allowRunningJobs", async () => {
    const owner = await scalar("SELECT id FROM users WHERE username = 'jane_smith'");
    await pool.query(
      "INSERT INTO jobs (owner_user_id, name, source_label, status, execution_provider) VALUES ($1, 'live-ec2', 'octo/demo', 'running', 'ec2')",
      [owner],
    );
    let message = "";
    try {
      await seedDemoUsers(pool, { replaceAll: true });
    } catch (error) {
      message = error.message;
    }
    assert(/EC2 jobs still queued or running/.test(message) && /live-ec2/.test(message), `Expected refusal, got: ${message || "no error"}`);
    assert((await scalar("SELECT COUNT(*)::int FROM jobs WHERE name = 'live-ec2'")) === 1, "Expected the job to survive the refused seed");

    await seedDemoUsers(pool, { replaceAll: true, allowRunningJobs: true });
    assert((await scalar("SELECT COUNT(*)::int FROM jobs WHERE name = 'live-ec2'")) === 0, "Expected the override to wipe it");
  }],

  ["seed ignores finished EC2 jobs and running local jobs", async () => {
    const owner = await scalar("SELECT id FROM users WHERE username = 'jane_smith'");
    await pool.query(
      `INSERT INTO jobs (owner_user_id, name, source_label, status, execution_provider) VALUES
         ($1, 'done-ec2', 'octo/demo', 'completed', 'ec2'), ($1, 'local-run', 'octo/demo', 'running', 'local')`,
      [owner],
    );
    await seedDemoUsers(pool, { replaceAll: true });
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
      JOIN classes c ON c.id = m.class_id AND c.teacher_id = $1
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
  ["github accounts: tokens round-trip, are encrypted at rest, removed with the user", async () => {
    const store = createGithubAccountsStore({ pool });
    const userId = await scalar("SELECT id FROM users WHERE username = 'jane_smith'");
    const expires = new Date(Date.now() + 8 * 3600 * 1000);
    await store.saveLink(userId, {
      githubUserId: 1001,
      githubLogin: "janehub",
      tokens: { accessToken: "ghu_exampleACCESS1234", refreshToken: "ghr_exampleREFRESH5678", accessExpiresAt: expires, refreshExpiresAt: null },
    });

    const tokens = await store.getTokens(userId);
    assert(tokens.accessToken === "ghu_exampleACCESS1234" && tokens.refreshToken === "ghr_exampleREFRESH5678", "tokens did not round-trip");
    assert(tokens.accessExpiresAt.getTime() === expires.getTime() && tokens.refreshExpiresAt === null, "expiry did not round-trip");
    const link = await store.getLink(userId);
    assert(link.githubLogin === "janehub" && link.githubUserId === 1001 && link.linkedAt, `link ${JSON.stringify(link)}`);

    const row = (await pool.query("SELECT * FROM connections WHERE user_id = $1 AND provider = 'github'", [userId])).rows[0];
    assert(row.key_id === "k1", `key_id ${row.key_id}`);
    assert(!/example(ACCESS|REFRESH)/.test(Buffer.from(row.ciphertext).toString("utf8")), "ciphertext contains a token");

    const tempId = await scalar("INSERT INTO users (username, display_name) VALUES ('cascade.test@lcps.org', 'Cascade Test') RETURNING id");
    await store.saveLink(tempId, { githubUserId: 1002, githubLogin: "cascade", tokens: { accessToken: "ghu_cascade" } });
    await pool.query("DELETE FROM users WHERE id = $1", [tempId]);
    assert((await scalar("SELECT count(*) FROM connections WHERE user_id = $1", [tempId])) === "0", "link should be deleted with the user");
  }],

  ["github accounts: a row copied to another user does not decrypt; one GitHub account per Talon user", async () => {
    const store = createGithubAccountsStore({ pool });
    const jane = await scalar("SELECT id FROM users WHERE username = 'jane_smith'");
    const other = await scalar("SELECT id FROM users WHERE username = 'student_a1'");
    await pool.query(
      `INSERT INTO connections (user_id, provider, external_id, external_login, key_id, iv, auth_tag, ciphertext)
       SELECT $2, provider, '999999', external_login, key_id, iv, auth_tag, ciphertext FROM connections WHERE user_id = $1 AND provider = 'github'`,
      [jane, other],
    );
    assert((await store.getTokens(other)) === null, "copied row must not decrypt for another user");
    assert((await store.getTokens(jane))?.accessToken.startsWith("ghu_"), "original row must still decrypt");
    await store.deleteLink(other);
    assert((await store.getLink(other)) === null, "deleteLink left a row");

    let inUse = false;
    try {
      await store.saveLink(other, { githubUserId: 1001, githubLogin: "janehub", tokens: { accessToken: "ghu_x" } });
    } catch (error) {
      inUse = error instanceof GithubAccountInUseError;
    }
    assert(inUse, "the same GitHub account must not link to a second Talon user");
  }],

  ["github accounts: key rotation keeps tokens readable", async () => {
    const store = createGithubAccountsStore({ pool });
    const userId = await scalar("SELECT id FROM users WHERE username = 'jane_smith'");
    const saved = { key: process.env.TALON_CREDENTIALS_KEY, id: process.env.TALON_CREDENTIALS_KEY_ID };
    const tokens = { accessToken: "ghu_rotateME12345678wxyz", refreshToken: "ghr_rotate" };

    try {
      process.env.TALON_CREDENTIALS_KEY = "old-test-secret";
      process.env.TALON_CREDENTIALS_KEY_ID = "old1";
      await store.saveLink(userId, { githubUserId: 1001, githubLogin: "janehub", tokens });

      // New key becomes current; old key is only kept for decrypting.
      process.env.TALON_CREDENTIALS_KEY = "new-test-secret";
      process.env.TALON_CREDENTIALS_KEY_ID = "new2";
      process.env.TALON_CREDENTIALS_OLD_KEYS = "old1:old-test-secret";
      assert((await store.getTokens(userId))?.accessToken === tokens.accessToken, "old key row unreadable after key change");

      // Without the old key listed, the row cannot be read (and nothing crashes).
      process.env.TALON_CREDENTIALS_OLD_KEYS = "";
      assert((await store.getTokens(userId)) === null, "row must be unreadable without its key");
      process.env.TALON_CREDENTIALS_OLD_KEYS = "old1:old-test-secret";

      const { execFileSync } = await import("node:child_process");
      const output = execFileSync("node", ["scripts/db-rotate-credentials-key.mjs"], {
        cwd: new URL("../..", import.meta.url).pathname,
        env: { ...process.env, DATABASE_URL: databaseUrl },
      }).toString();
      assert(/Rotated 1 connection token set\(s\) to key id 'new2'; 0 failed/.test(output), `rotation output: ${output}`);

      process.env.TALON_CREDENTIALS_OLD_KEYS = "";
      const after = await store.getTokens(userId);
      assert(after?.accessToken === tokens.accessToken && after.refreshToken === tokens.refreshToken, "tokens unreadable after rotation");
      assert((await scalar("SELECT key_id FROM connections WHERE user_id = $1", [userId])) === "new2", "key id not updated");
    } finally {
      for (const [name, value] of [["TALON_CREDENTIALS_KEY", saved.key], ["TALON_CREDENTIALS_KEY_ID", saved.id]]) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
      delete process.env.TALON_CREDENTIALS_OLD_KEYS;
      await store.deleteLink(userId);
    }
  }],

  ["github app: JWT is RS256, signed by the app key, at most 10 minutes", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const nowMs = Date.UTC(2026, 10, 3, 12, 0, 0);
    const jwt = createAppJwt({ clientId: "Iv1.test", privateKey }, nowMs);
    const [header, payload, signature] = jwt.split(".");
    assert(JSON.parse(Buffer.from(header, "base64url")).alg === "RS256", "alg");
    const claims = JSON.parse(Buffer.from(payload, "base64url"));
    assert(claims.iss === "Iv1.test" && claims.exp - claims.iat <= 600 && claims.iat < nowMs / 1000, `claims ${JSON.stringify(claims)}`);
    assert(createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature, "base64url")), "signature does not verify");
  }],

  ["github app: clone token is null for public repos, repo-scoped for private, refused when hidden", async () => {
    const userId = await scalar("SELECT id FROM users WHERE username = 'student_a1'");
    const fake = makeFakeGithub({
      "GET /repos/aet-cs/public-demo": { status: 200, data: { private: false } },
      "GET /repos/aet-cs/private-demo": { status: 200, data: { private: true } },
      "GET /repos/aet-cs/private-demo/installation": { status: 200, data: { id: 77 } },
      "POST /app/installations/77/access_tokens": { status: 201, data: { token: "ghs_installation" } },
    });
    const app = createGithubApp({ config: fakeGithubConfig(), store: createGithubAccountsStore({ pool }), fetch: fake.fetch });

    // Not linked: no GitHub calls, anonymous clone.
    assert((await app.resolveCloneToken(userId, "aet-cs/private-demo")) === null, "unlinked user should clone anonymously");
    assert(fake.calls.length === 0, "unlinked user should not call GitHub");

    await createGithubAccountsStore({ pool }).saveLink(userId, { githubUserId: 2001, githubLogin: "a1hub", tokens: { accessToken: "ghu_a1" } });
    assert((await app.resolveCloneToken(userId, "aet-cs/public-demo")) === null, "public repo should clone anonymously");
    assert((await app.resolveCloneToken(userId, "https://github.com/aet-cs/private-demo")) === "ghs_installation", "private repo should get an installation token");
    const mint = fake.calls.find((c) => c.key === "POST /app/installations/77/access_tokens");
    assert(JSON.stringify(mint.body) === JSON.stringify({ repositories: ["private-demo"], permissions: { contents: "read" } }), `mint body ${JSON.stringify(mint.body)}`);
    assert(mint.auth.startsWith("Bearer ey"), "installation token must be minted with the app JWT");
    assert(fake.calls.find((c) => c.key === "GET /repos/aet-cs/private-demo").auth === "Bearer ghu_a1", "access check must use the user's token");

    let refused = null;
    try {
      await app.resolveCloneToken(userId, "someone/else-private");
    } catch (error) {
      refused = error;
    }
    assert(refused?.status === 400 && /no access/.test(refused.message), `hidden repo: ${refused?.message}`);
    await createGithubAccountsStore({ pool }).deleteLink(userId);
  }],

  ["github app: expired access token is refreshed once; a dead refresh token unlinks", async () => {
    const userId = await scalar("SELECT id FROM users WHERE username = 'student_a2'");
    const store = createGithubAccountsStore({ pool });
    const past = new Date(Date.now() - 1000);
    await store.saveLink(userId, { githubUserId: 3001, githubLogin: "a2hub", tokens: { accessToken: "ghu_old", refreshToken: "ghr_old", accessExpiresAt: past } });

    const fake = makeFakeGithub({
      "POST /login/oauth/access_token": { status: 200, data: { access_token: "ghu_new", refresh_token: "ghr_new", expires_in: 28800, refresh_token_expires_in: 15897600 } },
    });
    const app = createGithubApp({ config: fakeGithubConfig(), store, fetch: fake.fetch });
    const [a, b] = await Promise.all([app.getUserAccessToken(userId), app.getUserAccessToken(userId)]);
    assert(a === "ghu_new" && b === "ghu_new", `tokens ${a} ${b}`);
    const refreshes = fake.calls.filter((c) => c.key === "POST /login/oauth/access_token");
    assert(refreshes.length === 1 && refreshes[0].body.refresh_token === "ghr_old", `refreshed ${refreshes.length} time(s)`);
    const stored = await store.getTokens(userId);
    assert(stored.refreshToken === "ghr_new" && stored.accessExpiresAt > new Date(), "refreshed tokens not saved");

    await store.saveLink(userId, { githubUserId: 3001, githubLogin: "a2hub", tokens: { accessToken: "ghu_old", refreshToken: "ghr_used", accessExpiresAt: past } });
    const dead = makeFakeGithub({ "POST /login/oauth/access_token": { status: 200, data: { error: "bad_refresh_token" } } });
    const deadApp = createGithubApp({ config: fakeGithubConfig(), store, fetch: dead.fetch });
    assert((await deadApp.getUserAccessToken(userId)) === null, "dead refresh token should give no token");
    assert((await store.getLink(userId)) === null, "dead refresh token should unlink");
  }],

  ["github app: linking stores the account; repo list covers every installation", async () => {
    const userId = await scalar("SELECT id FROM users WHERE username = 'student_a2'");
    const store = createGithubAccountsStore({ pool });
    const fake = makeFakeGithub({
      "POST /login/oauth/access_token": { status: 200, data: { access_token: "ghu_linked", refresh_token: "ghr_linked", expires_in: 28800 } },
      "GET /user": { status: 200, data: { id: 4001, login: "a2hub" } },
      "GET /user/installations?per_page=100": { status: 200, data: { installations: [{ id: 1 }, { id: 2 }] } },
      "GET /user/installations/1/repositories?per_page=100&page=1": { status: 200, data: { repositories: [{ full_name: "a2hub/zeta", private: true }] } },
      "GET /user/installations/2/repositories?per_page=100&page=1": { status: 200, data: { repositories: [{ full_name: "AET-CS/alpha", private: false }, { full_name: "a2hub/zeta", private: true }] } },
    });
    const app = createGithubApp({ config: fakeGithubConfig(), store, fetch: fake.fetch });
    const authorize = new URL(await app.authorizeUrl("state-abc"));
    assert(authorize.origin + authorize.pathname === "https://github.com/login/oauth/authorize", `authorize ${authorize}`);
    assert(authorize.searchParams.get("prompt") === "select_account" && authorize.searchParams.get("state") === "state-abc", `authorize params ${authorize.search}`);
    assert(authorize.searchParams.get("redirect_uri") === "http://localhost:5173/api/github/callback", "authorize redirect_uri");
    const install = new URL(await app.authorizeUrl("state-abc", "install"));
    assert(install.pathname === "/apps/talon-test/installations/new" && install.searchParams.get("state") === "state-abc", `install ${install}`);

    const linked = await app.completeLink(userId, "code-123");
    assert(linked.githubLogin === "a2hub", "login");
    const exchange = fake.calls.find((c) => c.key === "POST /login/oauth/access_token");
    assert(exchange.body.code === "code-123" && exchange.body.redirect_uri === "http://localhost:5173/api/github/callback", `exchange ${JSON.stringify(exchange.body)}`);
    assert((await store.getLink(userId)).githubUserId === 4001, "link not stored");

    const repos = await app.listRepos(userId);
    assert(JSON.stringify(repos) === JSON.stringify([{ fullName: "a2hub/zeta", private: true }, { fullName: "AET-CS/alpha", private: false }].sort((x, y) => x.fullName.localeCompare(y.fullName, undefined, { sensitivity: "base" }))), `repos ${JSON.stringify(repos)}`);
    await store.deleteLink(userId);
  }],

  ["github app: a token GitHub rejects (revoked) unlinks instead of failing", async () => {
    const userId = await scalar("SELECT id FROM users WHERE username = 'student_a3'");
    const store = createGithubAccountsStore({ pool });
    const revoked = makeFakeGithub({
      "GET /repos/pytorch/examples": { status: 401, data: { message: "Bad credentials" } },
      "GET /user/installations?per_page=100": { status: 401, data: { message: "Bad credentials" } },
    });
    const app = createGithubApp({ config: fakeGithubConfig(), store, fetch: revoked.fetch });

    await store.saveLink(userId, { githubUserId: 6001, githubLogin: "a3hub", tokens: { accessToken: "ghu_revoked" } });
    assert((await app.resolveCloneToken(userId, "pytorch/examples")) === null, "revoked token should fall back to an anonymous clone");
    assert((await store.getLink(userId)) === null, "revoked token should unlink (clone check)");

    await store.saveLink(userId, { githubUserId: 6001, githubLogin: "a3hub", tokens: { accessToken: "ghu_revoked" } });
    let error = null;
    try {
      await app.listRepos(userId);
    } catch (e) {
      error = e;
    }
    assert(error?.status === 409 && /Connect GitHub again/.test(error.message), `repo list: ${error?.status} ${error?.message}`);
    assert((await store.getLink(userId)) === null, "revoked token should unlink (repo list)");
  }],

  ["github app: slug may be given as the app's URL", async () => {
    assert(normalizeSlug("https://github.com/apps/talon-link") === "talon-link", "url form");
    assert(normalizeSlug("talon-link") === "talon-link", "plain form");
    assert(normalizeSlug(" https://github.com/apps/talon-link/ ") === "talon-link", "trailing slash");
  }],

  ["git: clone token reaches git through the environment only", async () => {
    const { execFileSync } = await import("node:child_process");
    const header = execFileSync("git", ["config", "--get", "http.https://github.com/.extraheader"], {
      env: { ...process.env, ...gitAuthEnv("ghs_secret") },
    }).toString().trim();
    assert(header === `AUTHORIZATION: basic ${Buffer.from("x-access-token:ghs_secret").toString("base64")}`, `header ${header}`);
    assert(JSON.stringify(gitAuthEnv(null)) === "{}", "no token should add nothing");
    assert(/connect GitHub/.test(describeCloneError("fatal: could not read Username for 'https://github.com': terminal prompts disabled")), "private-repo hint missing");
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

    let startedWith = null;
    const ok = await launchEc2Job({
      jobsRepository: jobs, user, isAdmin: false, maxRuntimeSeconds: 1800,
      payload: { name: "works", repo: "x/y", instanceType: "c7g.large", folder: "mnist", entryScript: "main.py", scriptArgs: "--save-model --epochs 2" },
      adapter: { async start(spec) { startedWith = spec; return { provider: "ec2", executionId: spec.jobId, jobId: spec.jobId, instanceId: "i-1" }; } },
    });
    assert(ok.executionRef.instanceId === "i-1" && ok.reservedCents > 0 && ok.computeType === undefined, `launched job ${JSON.stringify(ok)}`);
    assert(ok.folder === "mnist" && startedWith.folder === "mnist", `folder not stored or passed: ${ok.folder} / ${startedWith?.folder}`);
    assert(ok.scriptArgs === "--save-model --epochs 2" && JSON.stringify(startedWith.scriptArgs) === JSON.stringify(["--save-model", "--epochs", "2"]), `args: ${ok.scriptArgs} / ${JSON.stringify(startedWith.scriptArgs)}`);
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
      log: { info() {}, warn() {}, error() {} },
    });
    await reconciler.tick();
    assert(terminated.sort().join() === "i-finished,i-orphan,i-overrun,i-untagged", `terminated ${terminated.sort()}`);
  }],

  ["ec2 reconciler: only one server runs a tick (advisory lock)", async () => {
    const lockId = 990001;
    let ticks = 0;
    const reconciler = createEc2Reconciler({
      jobsRepository: { async listUnfinished() { ticks += 1; return []; }, async findById() { return null; } },
      adapter: { async listJobInstances() { return []; }, async terminateInstance() {} },
      sync: async () => {},
      markLost: async () => {},
      exclusive: (fn) => withTryAdvisoryLock(pool, lockId, fn),
      log: { debug() {}, info() {}, warn() {}, error() {} },
    });

    // Another "server" (its own connection) holds the lock: the tick is skipped.
    const other = new pg.Client({ connectionString: databaseUrl });
    await other.connect();
    try {
      await other.query("SELECT pg_advisory_lock($1)", [lockId]);
      const skipped = await reconciler.runOnce();
      assert(skipped.skipped === true && ticks === 0, `expected a skipped tick, got ${JSON.stringify(skipped)} after ${ticks} tick(s)`);
      await other.query("SELECT pg_advisory_unlock($1)", [lockId]);
    } finally {
      await other.end();
    }

    const ran = await reconciler.runOnce();
    assert(ran.skipped === false && ticks === 1, `expected the tick to run, got ${JSON.stringify(ran)}`);

    // The lock was released and is not left on a pooled connection.
    const held = await scalar("SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND objid = $1", [lockId]);
    assert(Number(held) === 0, `advisory lock still held by ${held} session(s)`);

    // Two at once (two servers on the same tick): exactly one runs.
    ticks = 0;
    let release;
    const slow = createEc2Reconciler({
      jobsRepository: { async listUnfinished() { ticks += 1; await new Promise((r) => { release = r; }); return []; }, async findById() { return null; } },
      adapter: { async listJobInstances() { return []; }, async terminateInstance() {} },
      sync: async () => {}, markLost: async () => {},
      exclusive: (fn) => withTryAdvisoryLock(pool, lockId, fn),
      log: { debug() {}, info() {}, warn() {}, error() {} },
    });
    const first = slow.runOnce();
    await waitFor(async () => ticks === 1, { timeoutMs: 5_000, label: "first tick started" });
    const second = await slow.runOnce();
    release();
    assert(second.skipped === true && (await first).skipped === false && ticks === 1, "concurrent ticks were not exclusive");
  }],

  ["health check: database up, refused and hanging", async () => {
    assert((await checkDatabase(pool)).ok === true, "test database should be healthy");

    const refused = new pg.Pool({ connectionString: "postgres://talon@127.0.0.1:1/talon", connectionTimeoutMillis: 1_000 });
    refused.on("error", () => {});
    try {
      const result = await checkDatabase(refused, { timeoutMs: 2_000 });
      assert(result.ok === false && result.error, "a refused connection is unhealthy");
    } finally {
      await refused.end();
    }

    const startedAt = Date.now();
    const hanging = await checkDatabase({ query: () => new Promise(() => {}) }, { timeoutMs: 200 });
    assert(hanging.ok === false && Date.now() - startedAt < 1_000, `a hanging database must time out quickly (${Date.now() - startedAt} ms)`);
  }],

  ["database url: transport and production TLS rule", async () => {
    const cases = {
      "postgres://talon@%2Fvar%2Frun%2Fpostgresql/talon": "socket",
      "postgresql:///talon?host=/var/run/postgresql": "socket",
      "postgres://localhost/talon_dev": "loopback",
      "postgres://talon@127.0.0.1:5432/talon": "loopback",
      "postgres://talon@db.abc.us-east-1.rds.amazonaws.com:5432/talon?sslmode=verify-full&sslrootcert=/etc/talon/rds-ca.pem": "tls",
      "postgres://talon@db.abc.us-east-1.rds.amazonaws.com:5432/talon?sslmode=require": "plaintext",
      "postgres://talon@db.abc.us-east-1.rds.amazonaws.com:5432/talon": "plaintext",
    };
    for (const [url, want] of Object.entries(cases)) {
      assert(databaseTransport(url) === want, `${url}: expected ${want}, got ${databaseTransport(url)}`);
    }

    const production = { NODE_ENV: "production" };
    assertSecureDatabaseUrl("postgres://talon@%2Fvar%2Frun%2Fpostgresql/talon", production);
    assertSecureDatabaseUrl("postgres://talon@db.example.com/talon?sslmode=verify-full", production);
    assertSecureDatabaseUrl("postgres://talon:pw@db.example.com/talon", { NODE_ENV: "development" });
    let message = "";
    try {
      assertSecureDatabaseUrl("postgres://talon:s3cretPW@db.example.com/talon", production);
    } catch (error) {
      message = error.message;
    }
    assert(/verify-full/.test(message) && !message.includes("s3cretPW"), `expected a refusal without the password, got: ${message}`);
  }],

  ["database url: IAM sign-in config and the migration role switch", async () => {
    const plain = connectionConfig("postgres://localhost/talon_dev", {});
    assert(plain.connectionString === "postgres://localhost/talon_dev" && !plain.password, "without IAM the URL is passed through");

    const signed = [];
    const createSigner = (opts) => ({ getAuthToken: async () => { signed.push(opts); return "token-123"; } });
    const iam = connectionConfig(
      "postgres://talon_app@db.abc.us-east-1.rds.amazonaws.com:5432/talon?sslmode=verify-full",
      { DATABASE_IAM_AUTH: "true", AWS_REGION: "us-east-1" },
      { createSigner },
    );
    assert(!iam.connectionString, "IAM config must not carry a connection string (its empty password would win)");
    assert(iam.user === "talon_app" && iam.host === "db.abc.us-east-1.rds.amazonaws.com" && iam.port === 5432 && iam.database === "talon", `parsed ${JSON.stringify(iam)}`);
    assert(iam.ssl && iam.ssl.rejectUnauthorized !== false, "verify-full keeps certificate checks on");
    assert((await iam.password()) === "token-123", "password comes from the signer");
    assert(signed[0].hostname === iam.host && signed[0].port === 5432 && signed[0].username === "talon_app" && signed[0].region === "us-east-1", `signer got ${JSON.stringify(signed[0])}`);

    let refused = "";
    try {
      connectionConfig("postgres://talon_app@localhost/talon", { DATABASE_IAM_AUTH: "true" }, { createSigner });
    } catch (error) {
      refused = error.message;
    }
    assert(/verify-full/.test(refused), `IAM without TLS must be refused, got: ${refused}`);

    const env = { DATABASE_URL: "postgres://talon_app@h/talon", DATABASE_MIGRATE_URL: "postgres://talon_migrate@h/talon" };
    useMigrationRole(env);
    assert(env.DATABASE_URL === "postgres://talon_migrate@h/talon", "migration role switches DATABASE_URL");
    const unset = { DATABASE_URL: "postgres://localhost/talon_dev" };
    useMigrationRole(unset);
    assert(unset.DATABASE_URL === "postgres://localhost/talon_dev", "no DATABASE_MIGRATE_URL: unchanged (dev, old box)");
  }],

  ["finalize: concurrent calls settle once and only one reports it did the work", async () => {
    const jobs = createJobsPostgresRepository({ pool });
    const owner = await scalar("SELECT id FROM users WHERE username = 'admin'");
    const job = await jobs.createWithReservation({
      ownerUserId: owner, name: "finalize-race", repo: "x/y", executionProvider: "ec2", hourlyRateCents: 360,
      maxRuntimeSeconds: 100, reserveCents: 5, enforceBalance: false,
    });
    const args = { syncKey: "race-1", status: "completed", durationSeconds: 10, finalizedAt: new Date().toISOString() };
    const results = await Promise.all([jobs.finalize(job.id, args), jobs.finalize(job.id, args)]);
    const marked = results.filter((r) => r[justFinalized]);
    assert(marked.length === 1, `exactly one call did the work, got ${marked.length}`);
    assert(!JSON.stringify(results[0]).includes("justFinalized"), "the marker is not serialized");
    const again = await jobs.finalize(job.id, args);
    assert(!again[justFinalized], "a repeat call does nothing");
    // Only the reservation charge: the whole 5 c was used, nothing to refund, and the repeats added nothing.
    assert(Number(await scalar("SELECT count(*) FROM budget_ledger WHERE job_id = $1", [job.id])) === 1, "ledger settled once");
  }],

  ["ec2 reconciler: a job whose execution is gone is marked lost; other sync errors leave it alone", async () => {
    const jobs = createJobsPostgresRepository({ pool });
    const owner = await scalar("SELECT id FROM users WHERE username = 'admin'");
    // Launched jobs (with an execution ref); jobs still being prepared are not synced.
    const mk = async (name) => {
      const job = await jobs.createWithReservation({
        ownerUserId: owner, name, repo: "x/y", executionProvider: "ec2", hourlyRateCents: 360,
        maxRuntimeSeconds: 100, reserveCents: 5, enforceBalance: false,
      });
      return jobs.setExecutionRef(job.id, { provider: "ec2", executionId: job.id, jobId: job.id, instanceId: `i-${job.id}` });
    };
    const gone = await mk("lost-gone");
    const flaky = await mk("lost-flaky");
    const fine = await mk("lost-fine");

    const synced = [];
    const lost = [];
    const errors = [];
    const reconciler = createEc2Reconciler({
      jobsRepository: { ...jobs, async listUnfinished() { return [gone, flaky, fine]; } },
      adapter: { async listJobInstances() { return []; }, async terminateInstance() {} },
      sync: async (job) => {
        synced.push(job.id);
        if (job.id === gone.id) throw Object.assign(new Error("not found"), { status: 404 });
        if (job.id === flaky.id) throw new Error("AWS throttled");
      },
      markLost: async (job) => { lost.push(job.id); },
      log: { info() {}, warn() {}, error(msg, fields) { errors.push(fields); } },
    });
    await reconciler.tick();
    assert(synced.length === 3, `a failing job must not stop the others: synced ${synced}`);
    assert(lost.length === 1 && lost[0] === gone.id, `only the 404 job is lost: ${lost}`);
    assert(errors.length === 1 && errors[0].jobId === flaky.id && errors[0].err.message.includes("AWS throttled"), `errors ${JSON.stringify(errors)}`);
  }],

  ["ec2 reconciler + jobSync: a vanished instance fails the job, is billed from launch time, the rest refunded once", async () => {
    const jobs = createJobsPostgresRepository({ pool });
    const userId = await scalar("SELECT id FROM users WHERE username = 'student_a1'");
    const accountId = await withTransaction((client) => ensureAccount(client, userId, "personal"), { pool });
    await pool.query("UPDATE budget_accounts SET balance_cents = balance_cents + 1000 WHERE id = $1", [accountId]);
    await pool.query("INSERT INTO budget_ledger (account_id, amount_cents, kind, note) VALUES ($1, 1000, 'grant', 'test top-up')", [accountId]);
    const balance = async () => Number(await scalar("SELECT balance_cents FROM budget_accounts WHERE id = $1", [accountId]));
    const start = await balance();

    const job = await jobs.createWithReservation({
      ownerUserId: userId, name: "vanished", repo: "x/y", executionProvider: "ec2",
      hourlyRateCents: 360, maxRuntimeSeconds: 1800, reserveCents: 200,
    });
    await jobs.setExecutionRef(job.id, { provider: "ec2", executionId: job.id, jobId: job.id, instanceId: "i-gone", launchedAt: "2026-01-01T00:00:00Z" });
    assert((await balance()) === start - 200, "reserved at creation");

    const sync = createJobSync({
      jobsRepository: jobs,
      getExecutionStatus: async () => { throw Object.assign(new Error("instance not found"), { status: 404 }); },
      getExecutionOutputFiles: async () => [],
      now: () => Date.parse("2026-01-01T00:10:00Z"),
    });
    // Earlier tests leave unfinished ec2 jobs behind; only look at this one.
    const onlyThisJob = { ...jobs, async listUnfinished(provider) { return (await jobs.listUnfinished(provider)).filter((j) => j.id === job.id); } };
    const reconciler = createEc2Reconciler({
      jobsRepository: onlyThisJob,
      adapter: { async listJobInstances() { return []; }, async terminateInstance() {} },
      sync: sync.synchronizeJobFromExecution,
      markLost: sync.markJobAsExecutionLost,
      log: { info() {}, warn() {}, error() {} },
    });
    await reconciler.tick();
    await reconciler.tick();

    const after = await jobs.findById(job.id);
    assert(after.status === "failed" && String(after.resultSyncKey).startsWith("lost:"), `job ${after.status} ${after.resultSyncKey}`);
    // Launched 10 minutes before it was found missing: 600 s at 360 c/h = 60 c.
    assert(after.costCents === 60 && after.duration, `lost job is billed its runtime, got ${after.costCents} ${after.duration}`);
    assert((await balance()) === start - 60, `reservation minus runtime comes back, balance moved ${start - (await balance())}`);
    assert(Number(await scalar("SELECT count(*) FROM results WHERE job_id = $1", [job.id])) === 1, "one result row");
    assert(Number(await scalar("SELECT count(*) FROM budget_ledger WHERE job_id = $1 AND kind = 'refund'", [job.id])) === 1, "one refund");

    // Found missing days later: billed no more than the time limit plus the boot allowance (all that was reserved).
    const stale = await jobs.createWithReservation({
      ownerUserId: userId, name: "vanished-days", repo: "x/y", executionProvider: "ec2",
      hourlyRateCents: 360, maxRuntimeSeconds: 1800, reserveCents: 200,
    });
    await jobs.setExecutionRef(stale.id, { provider: "ec2", executionId: stale.id, launchedAt: "2025-12-01T00:00:00Z" });
    const lostStale = await sync.markJobAsExecutionLost(await jobs.findById(stale.id));
    assert(lostStale.costCents === 200, `capped cost ${lostStale.costCents}`);
    assert((await pool.query("SELECT duration_seconds FROM jobs WHERE id = $1", [stale.id])).rows[0].duration_seconds === 2100, "duration capped at limit + allowance");

    // Never launched (no launch time recorded): nothing to bill, everything comes back.
    const unlaunched = await jobs.createWithReservation({
      ownerUserId: userId, name: "vanished-unlaunched", repo: "x/y", executionProvider: "ec2",
      hourlyRateCents: 360, maxRuntimeSeconds: 1800, reserveCents: 200,
    });
    await jobs.setExecutionRef(unlaunched.id, { provider: "ec2", executionId: unlaunched.id });
    const lostUnlaunched = await sync.markJobAsExecutionLost(await jobs.findById(unlaunched.id));
    assert(lostUnlaunched.costCents === 0, `unlaunched cost ${lostUnlaunched.costCents}`);
    assert((await balance()) === start - 60 - 200, `balance after all three ${start - (await balance())}`);
    assert((await onlyThisJob.listUnfinished("ec2")).length === 0, "no longer unfinished");
  }],

  ["jobSync: progress, completion, failure messages, and repeat syncs do not finalize twice", async () => {
    const jobs = createJobsPostgresRepository({ pool });
    const owner = await scalar("SELECT id FROM users WHERE username = 'admin'");
    const mk = async (name) => {
      const job = await jobs.create({ ownerUserId: owner, name, repo: "x/y" });
      await jobs.setExecutionRef(job.id, { provider: "local", executionId: `exec-${name}` });
      return jobs.findById(job.id);
    };
    let execution = {};
    let fileCalls = 0;
    let filesError = false;
    const sync = createJobSync({
      jobsRepository: jobs,
      getExecutionStatus: async () => execution,
      getExecutionOutputFiles: async () => {
        fileCalls += 1;
        if (filesError) throw new Error("s3 down");
        return [{ name: "model.bin", size: "1 KB", source: "output_dir" }, { size: 5 }];
      },
    });
    const resultRow = async (jobId) => (await pool.query("SELECT * FROM results WHERE job_id = $1", [jobId])).rows[0];

    // No execution ref: nothing to look at.
    const bare = await jobs.create({ ownerUserId: owner, name: "sync-bare", repo: "x/y" });
    const untouched = await sync.synchronizeJobFromExecution(await jobs.findById(bare.id));
    assert(untouched.job.id === bare.id && untouched.execution === undefined, "job without a ref comes back as is");

    // Progress while running; the same state again changes nothing.
    const running = await mk("sync-running");
    execution = { state: "running", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:01:30Z" };
    let out = await sync.synchronizeJobFromExecution(running);
    assert(out.job.status === "running" && out.job.duration && !out.job.resultSyncKey, `running ${JSON.stringify(out.job)}`);
    assert(!(await resultRow(running.id)), "no result row while running");

    // Completion stores the result with normalized files; a repeat is a no-op.
    const done = await mk("sync-done");
    execution = { state: "completed", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:02:00Z" };
    out = await sync.synchronizeJobFromExecution(done);
    assert(out.job.status === "completed" && out.job.resultSyncKey === "2026-01-01T00:02:00Z", `done ${JSON.stringify(out.job)}`);
    const row = await resultRow(done.id);
    assert(row.status === "completed" && row.error === null && row.duration_seconds === 120, `result ${JSON.stringify(row)}`);
    assert(row.files.length === 2 && row.files[0].name === "model.bin" && row.files[1].name === "unnamed" && row.files[1].size === "5", `files ${JSON.stringify(row.files)}`);
    const callsBefore = fileCalls;
    out = await sync.synchronizeJobFromExecution(out.job);
    assert(fileCalls === callsBefore, "an already-synced job must not be finalized again");
    assert(Number(await scalar("SELECT count(*) FROM results WHERE job_id = $1", [done.id])) === 1, "one result row");

    // Failure messages.
    const failureError = async (name, state) => {
      const job = await mk(name);
      execution = { endedAt: "2026-01-01T00:03:00Z", ...state };
      const result = await sync.synchronizeJobFromExecution(job);
      assert(result.job.status === "failed", `${name} status ${result.job.status}`);
      return (await resultRow(job.id)).error;
    };
    assert((await failureError("sync-cancel", { state: "cancelled" })) === "Job cancelled", "cancelled message");
    assert((await failureError("sync-msg", { state: "failed", message: "Time limit reached" })) === "Time limit reached", "execution message wins");
    assert((await failureError("sync-oom", { state: "failed", exitCode: 137 })).includes("out of memory"), "exit 137 explains memory");
    assert((await failureError("sync-exit", { state: "failed", exitCode: 2 })) === "Execution failed (exit code 2)", "exit code is shown");
    assert((await failureError("sync-plain", { state: "failed" })) === "Execution failed", "plain failure");

    // A file listing error must not stop the job from being finalized.
    filesError = true;
    const noFiles = await mk("sync-nofiles");
    execution = { state: "completed", endedAt: "2026-01-01T00:04:00Z" };
    out = await sync.synchronizeJobFromExecution(noFiles);
    assert(out.job.status === "completed" && (await resultRow(noFiles.id)).files.length === 0, "finalized without files");
    filesError = false;

    // The sync key from the execution wins over the end time.
    const keyed = await mk("sync-keyed");
    execution = { state: "completed", syncKey: "custom-key", endedAt: "2026-01-01T00:05:00Z" };
    out = await sync.synchronizeJobFromExecution(keyed);
    assert(out.job.resultSyncKey === "custom-key", `key ${out.job.resultSyncKey}`);
  }],

  ["jobSync: markJobAsExecutionLost fails the job once, and only fixes the status of one already finalized", async () => {
    const jobs = createJobsPostgresRepository({ pool });
    const owner = await scalar("SELECT id FROM users WHERE username = 'admin'");
    const sync = createJobSync({ jobsRepository: jobs, getExecutionStatus: async () => ({}), getExecutionOutputFiles: async () => [] });
    const mk = async (name) => {
      const job = await jobs.create({ ownerUserId: owner, name, repo: "x/y" });
      await jobs.setExecutionRef(job.id, { provider: "local", executionId: `exec-${name}` });
      return jobs.findById(job.id);
    };

    const job = await mk("lost-once");
    const lost = await sync.markJobAsExecutionLost(job);
    assert(lost.status === "failed" && lost.resultSyncKey === "lost:exec-lost-once", `lost ${JSON.stringify(lost)}`);
    const row = (await pool.query("SELECT * FROM results WHERE job_id = $1", [job.id])).rows[0];
    assert(row.status === "failed" && row.error.startsWith("Execution record missing"), `result ${JSON.stringify(row)}`);

    // Finalized as completed earlier, but the status was left at running: only the status changes.
    const finished = await mk("lost-finalized");
    await jobs.finalize(finished.id, { syncKey: "done", status: "completed", durationSeconds: 5 });
    await pool.query("UPDATE jobs SET status = 'running' WHERE id = $1", [finished.id]);
    const fixed = await sync.markJobAsExecutionLost(await jobs.findById(finished.id));
    assert(fixed.status === "failed" && fixed.resultSyncKey === "done", `fixed ${JSON.stringify(fixed)}`);
    const kept = (await pool.query("SELECT status, error FROM results WHERE job_id = $1", [finished.id])).rows[0];
    assert(kept.status === "completed" && kept.error === null, "stored result is left alone");

    // No execution ref at all falls back to "unknown".
    const bare = await jobs.create({ ownerUserId: owner, name: "lost-bare", repo: "x/y" });
    const bareLost = await sync.markJobAsExecutionLost(await jobs.findById(bare.id));
    assert(bareLost.resultSyncKey === "lost:unknown", `bare ${bareLost.resultSyncKey}`);
  }],

  ["connections store: one row per user and provider; providers do not see each other's rows", async () => {
    const github = createConnectionsStore({ provider: "github", tokenPurpose: "github-app-tokens", pool });
    const drive = createConnectionsStore({ provider: "google_drive", tokenPurpose: "test-drive-tokens", pool });
    const userId = await scalar("SELECT id FROM users WHERE username = 'student_a1'");
    const other = await scalar("SELECT id FROM users WHERE username = 'jane_smith'");
    await github.saveLink(userId, { externalId: "77", login: "a1hub", clientId: "Iv1.one", tokens: { accessToken: "gh-secret" } });
    await drive.saveLink(userId, { externalId: "google-sub-1", login: "a1@example.com", clientId: "drive-client", tokens: { accessToken: "ya29-secret", refreshToken: "1//r", accessExpiresAt: new Date(Date.now() + 3600e3) } });

    assert((await github.getTokens(userId)).accessToken === "gh-secret", "github tokens");
    const driveTokens = await drive.getTokens(userId);
    assert(driveTokens.accessToken === "ya29-secret" && driveTokens.refreshToken === "1//r" && driveTokens.accessExpiresAt && driveTokens.login === "a1@example.com", `drive tokens ${JSON.stringify(driveTokens)}`);
    assert((await drive.getLink(userId)).clientId === "drive-client", "client id stored");
    assert(!/ya29-secret/.test(String(await scalar("SELECT ciphertext FROM connections WHERE user_id = $1 AND provider = 'google_drive'", [userId]))), "ciphertext holds the token");

    // A row's purpose is bound into its ciphertext: relabelling a GitHub row
    // as another provider does not make it readable there.
    await pool.query("DELETE FROM connections WHERE user_id = $1 AND provider = 'google_drive'", [userId]);
    await pool.query(
      `INSERT INTO connections (user_id, provider, external_id, external_login, key_id, iv, auth_tag, ciphertext)
       SELECT user_id, 'google_drive', 'moved', external_login, key_id, iv, auth_tag, ciphertext FROM connections WHERE user_id = $1 AND provider = 'github'`,
      [userId],
    );
    assert((await drive.getTokens(userId)) === null, "a row from another provider must not decrypt");

    // The same outside account id may exist under two providers, but not twice under one.
    await drive.saveLink(other, { externalId: "77", login: "x", tokens: { accessToken: "t" } });
    let inUse = null;
    try { await github.saveLink(other, { externalId: "77", login: "x", tokens: { accessToken: "t" } }); } catch (error) { inUse = error; }
    assert(inUse instanceof ConnectionInUseError && inUse.provider === "github", `expected in-use, got ${inUse}`);
    await github.deleteLink(userId);
    assert((await drive.getLink(other)) && (await github.getLink(userId)) === null, "deleteLink is per provider");
    await pool.query("DELETE FROM connections WHERE user_id = ANY($1)", [[userId, other]]);
  }],

  ["google drive: connect stores the account and client; lists picked files; picker config; unlink revokes", async () => {
    const userId = await scalar("SELECT id FROM users WHERE username = 'student_a1'");
    const google = makeFakeGoogle({
      "POST oauth2.googleapis.com/token": () => ({ access_token: "ya29.first", refresh_token: "1//refresh", expires_in: 3599, scope: `openid ${driveScope} email` }),
      "GET openidconnect.googleapis.com/v1/userinfo": () => ({ sub: "g-111", email: "a2@example.com" }),
      "GET www.googleapis.com/drive/v3/files/folderId0001": () => ({ id: "folderId0001", name: "lab3", mimeType: "application/vnd.google-apps.folder", trashed: false }),
      "GET www.googleapis.com/drive/v3/files/fileId000002": () => ({ id: "fileId000002", name: "train.py", mimeType: "text/x-python", trashed: false }),
      "GET www.googleapis.com/drive/v3/files/docId0000003": () => ({ id: "docId0000003", name: "Notes", mimeType: "application/vnd.google-apps.document", trashed: false }),
      "GET www.googleapis.com/drive/v3/files/trashId00004": () => ({ id: "trashId00004", name: "old.py", mimeType: "text/x-python", trashed: true }),
      "POST oauth2.googleapis.com/revoke": () => ({}),
    });
    const drive = createGoogleDriveProvider({ store: driveStore(), settings: fakeGoogleSettings(), fetch: google.fetch });

    const url = new URL(await drive.authorizeUrl("st4te"));
    const q = Object.fromEntries(url.searchParams);
    assert(url.host === "accounts.google.com" && q.client_id === "client-1" && q.state === "st4te" && q.access_type === "offline", `authorize ${url}`);
    assert(q.redirect_uri === "http://localhost:5173/api/connections/google_drive/callback" && q.scope.includes(driveScope) && /consent/.test(q.prompt), `authorize params ${JSON.stringify(q)}`);

    assert((await drive.completeCallback(userId, { code: "c0de" })) === "connected", "connect");
    const tokenCall = google.calls.find((c) => c.key === "POST oauth2.googleapis.com/token");
    assert(tokenCall.body.code === "c0de" && tokenCall.body.grant_type === "authorization_code" && tokenCall.body.client_secret === "secret-1", `token call ${JSON.stringify(tokenCall.body)}`);
    const link = await drive.getLink(userId);
    assert(link.login === "a2@example.com" && link.needsReconnect === false, `link ${JSON.stringify(link)}`);
    const row = (await pool.query("SELECT external_id, client_id, ciphertext FROM connections WHERE user_id = $1 AND provider = 'google_drive'", [userId])).rows[0];
    assert(row.external_id === "g-111" && row.client_id === "client-1" && !/ya29|1\/\/refresh/.test(Buffer.from(row.ciphertext).toString("utf8")), "stored link");

    // Picks are checked with Drive (the student's token) and stored; the
    // list is what was picked, never the whole Drive.
    assert((await drive.listItems(userId)).length === 0, "nothing picked yet");
    const items = await drive.addPickedItems(userId, ["fileId000002", "folderId0001", "docId0000003", "fileId000002"]);
    assert(JSON.stringify(items.map((i) => [i.id, i.label, i.kind])) === '[["folderId0001","lab3","folder"],["docId0000003","Notes","google-doc"],["fileId000002","train.py","file"]]', `items ${JSON.stringify(items)}`);
    assert(google.calls.filter((c) => c.key.startsWith("GET www.googleapis.com/drive/v3/files/")).every((c) => c.auth === "Bearer ya29.first"), "checks use the user's token");
    for (const [ids, pattern] of [[["trashId00004"], /trash/], [["missingId0005"], /cannot be read/], [["../etc"], /between 1 and 50/], [[], /between 1 and 50/]]) {
      let message = "";
      try { await drive.addPickedItems(userId, ids); } catch (error) { message = `${error.status} ${error.message}`; }
      assert(/^400 /.test(message) && pattern.test(message), `${JSON.stringify(ids)}: ${message}`);
    }
    assert((await drive.listItems(userId)).length === 3, "refused picks are not stored");
    assert((await drive.removePickedItem(userId, "docId0000003")) === true && (await drive.removePickedItem(userId, "docId0000003")) === false, "remove a pick");
    const picker = await drive.pickerConfig(userId);
    assert(picker.accessToken === "ya29.first" && picker.apiKey === "picker-key" && picker.appId === "123456", `picker ${JSON.stringify(picker)}`);

    // The Picker's app id must be the project number; a project ID falls back to the client id's prefix.
    assert(pickerAppId({ projectNumber: "my-project-id", clientId: "987654-abc.apps.googleusercontent.com" }) === "987654", "app id from the client id");
    assert(pickerAppId({ projectNumber: "", clientId: "555-x.apps.googleusercontent.com" }) === "555", "app id when unset");

    // Another OAuth client (the project moved): the link asks to reconnect.
    const moved = createGoogleDriveProvider({ store: driveStore(), settings: { ...fakeGoogleSettings(), clientId: "client-2" }, fetch: google.fetch });
    assert((await moved.getLink(userId)).needsReconnect === true, "client change should ask for a reconnect");

    // The same Google account cannot link to a second Talon user.
    const other = await scalar("SELECT id FROM users WHERE username = 'jane_smith'");
    const revokesBefore = google.calls.filter((c) => c.key === "POST oauth2.googleapis.com/revoke").length;
    assert((await drive.completeCallback(other, { code: "again" })) === "in-use", "second user with the same Google account");
    assert(google.calls.filter((c) => c.key === "POST oauth2.googleapis.com/revoke").length === revokesBefore, "in-use must not revoke the first user's grant");
    assert((await drive.getAccessToken(userId)) === "ya29.first", "first user's link still works");

    // A link made with the narrower drive.file permission must reconnect.
    await driveStore().withLockedTokens(userId, (tokens, save) => save({ ...tokens, scope: "openid email https://www.googleapis.com/auth/drive.file" }));
    assert((await drive.getLink(userId)).needsReconnect === true, "drive.file link should ask for a reconnect");

    await drive.unlink(userId);
    assert((await scalar("SELECT count(*)::int FROM connection_items WHERE user_id = $1", [userId])) === 0, "picks go with the link");
    const revoke = google.calls.filter((c) => c.key === "POST oauth2.googleapis.com/revoke").at(-1);
    assert(revoke && /token=1%2F%2Frefresh/.test(revoke.url), `revoke ${revoke?.url}`);
    assert((await drive.getLink(userId)) === null, "unlink should delete the link");
  }],

  ["google drive: unticked Drive permission is refused; tokens refresh; a dead refresh token unlinks", async () => {
    const userId = await scalar("SELECT id FROM users WHERE username = 'student_a1'");
    let tokenReply = () => ({ access_token: "ya29.noscope", refresh_token: "1//x", expires_in: 3599, scope: "openid email" });
    const google = makeFakeGoogle({
      "POST oauth2.googleapis.com/token": (body) => tokenReply(body),
      "GET openidconnect.googleapis.com/v1/userinfo": () => ({ sub: "g-222", email: "a2@example.com" }),
      "POST oauth2.googleapis.com/revoke": () => ({}),
    });
    let clock = Date.now();
    const drive = createGoogleDriveProvider({ store: driveStore(), settings: fakeGoogleSettings(), fetch: google.fetch, now: () => clock });
    assert((await drive.completeCallback(userId, { code: "c" })) === "missing-scope", "missing drive.file scope must be refused");
    assert(google.calls.some((c) => c.key === "POST oauth2.googleapis.com/revoke") && (await drive.getLink(userId)) === null, "refused grant is revoked, not stored");

    tokenReply = () => ({ access_token: "ya29.one", refresh_token: "1//keep", expires_in: 3600, scope: driveScope });
    assert((await drive.completeCallback(userId, { code: "c" })) === "connected", "connect");
    assert((await drive.getAccessToken(userId)) === "ya29.one", "fresh token used as is");

    clock += 3600 * 1000; // expired
    tokenReply = (body) => (body.grant_type === "refresh_token" && body.refresh_token === "1//keep" ? { access_token: "ya29.two", expires_in: 3600, scope: driveScope } : { error: "bad" });
    assert((await drive.getAccessToken(userId)) === "ya29.two", "refreshed token");
    clock += 3600 * 1000;
    tokenReply = (body) => (body.refresh_token === "1//keep" ? { access_token: "ya29.three", expires_in: 3600 } : { error: "lost refresh token" });
    assert((await drive.getAccessToken(userId)) === "ya29.three", "refresh token kept when Google sends none");

    clock += 3600 * 1000;
    tokenReply = () => ({ __status: 400, error: "invalid_grant" });
    assert((await drive.getAccessToken(userId)) === null && (await drive.getLink(userId)) === null, "invalid_grant should unlink");

    const unconfigured = createGoogleDriveProvider({ store: driveStore(), env: {}, fetch: google.fetch });
    assert((await unconfigured.status()).configured === false, "no settings: not configured");
    let status = 0;
    try { await unconfigured.listItems(userId); } catch (error) { status = error.status; }
    assert(status === 503, `listing without settings should be 503, got ${status}`);
  }],

  ["google drive: a rejected client secret is re-read next time, so fixing it needs no restart", async () => {
    const userId = await scalar("SELECT id FROM users WHERE username = 'student_a1'");
    const env = { GOOGLE_OAUTH_CLIENT_ID: "client-1", GOOGLE_OAUTH_CLIENT_SECRET: "wrong", GOOGLE_PICKER_API_KEY: "k", GOOGLE_PROJECT_NUMBER: "1", TALON_PUBLIC_URL: "http://localhost:5173" };
    const google = makeFakeGoogle({
      "POST oauth2.googleapis.com/token": (body) => (body.client_secret === "right"
        ? { access_token: "ya29.ok", refresh_token: "1//r", expires_in: 3600, scope: driveScope }
        : { __status: 401, error: "invalid_client" }),
      "GET openidconnect.googleapis.com/v1/userinfo": () => ({ sub: "g-reload", email: "a1@example.com" }),
    });
    const drive = createGoogleDriveProvider({ store: driveStore(), env, fetch: google.fetch });
    let first = "";
    try { await drive.completeCallback(userId, { code: "c" }); } catch (error) { first = error.message; }
    assert(/invalid_client/.test(first), `first attempt: ${first}`);
    env.GOOGLE_OAUTH_CLIENT_SECRET = "right"; // the corrected value (SSM in production)
    assert((await drive.completeCallback(userId, { code: "c" })) === "connected", "second attempt should use the new secret");
    await drive.unlink(userId).catch(() => {});
    await driveStore().deleteLink(userId);
  }],

  ["drive client: copies a folder tree, skips Google files, makes names safe and unique, enforces limits", async () => {
    const fake = makeFakeDrive(sampleDriveTree());
    const client = createDriveClient({ token: "t", fetch: fake.fetch });
    assert((await client.resolveFolder("rootFolder01", "week3/cnn")) === "cnnFolder001", "resolve by names");
    let message = "";
    try { await client.resolveFolder("rootFolder01", "week3/nope"); } catch (error) { message = `${error.status} ${error.message}`; }
    assert(/^400 Folder not found/.test(message), message);

    const dir = await mkdtemp(path.join(os.tmpdir(), "talon-drive-"));
    try {
      const progress = [];
      const copied = await client.copyFolder("cnnFolder001", path.join(dir, "out"), { maxFiles: 100, maxBytes: 10_000, onProgress: (line) => progress.push(line) });
      assert(/^Found 6 files .* in 2 folders; not copying /.test(progress[0]) && /\.git\//.test(progress[0]) && /myenv\//.test(progress[0]) && /__pycache__\//.test(progress[0]), `progress ${JSON.stringify(progress)}`);
      assert(/^Copied 6 of 6 files/.test(progress.at(-1)), `last progress ${progress.at(-1)}`);
      const paths = copied.files.map((f) => f.path).sort();
      assert(JSON.stringify(paths) === JSON.stringify(["data/a.csv", "data/notes (2).txt", "data/notes.txt", "data/odd_name.txt", "requirements.txt", "train.py"]), `paths ${paths}`);
      assert(JSON.stringify([...copied.skipped].sort()) === '[".git/","Plan","__pycache__/","myenv/"]', `skipped ${copied.skipped}`);
      const aborted = new AbortController();
      aborted.abort();
      let cancelled = "";
      try { await client.copyFolder("cnnFolder001", path.join(dir, "cancelled"), { maxFiles: 100, maxBytes: 10_000, signal: aborted.signal }); } catch (error) { cancelled = `${error.status} ${error.message}`; }
      assert(cancelled === "499 Cancelled", `abort: ${cancelled}`);
      assert(copied.files.every((f) => f.md5 && f.modifiedTime && f.id), "fingerprints recorded");
      const listing = execFileSync("find", [".", "-type", "f"], { cwd: path.join(dir, "out") }).toString().split("\n").filter(Boolean).sort();
      assert(listing.length === 6 && !listing.some((f) => f.includes("secret")), `on disk ${listing}`);
      const { readFile } = await import("node:fs/promises");
      assert((await readFile(path.join(dir, "out", "data", "notes (2).txt"), "utf8")) === "two", "duplicate kept apart");

      for (const [limits, pattern] of [[{ maxFiles: 3, maxBytes: 10_000 }, /more than 3 files/], [{ maxFiles: 100, maxBytes: 10 }, /larger than/]]) {
        let refused = "";
        try { await client.copyFolder("cnnFolder001", path.join(dir, `x${Math.random()}`), limits); } catch (error) { refused = error.message; }
        assert(pattern.test(refused), `expected ${pattern}, got ${refused}`);
      }
      assert(safeName("..") === "_" && safeName("a/b\\c") === "a_b_c", "safe names");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }],

  ["google drive: browse and locate stay inside picked items", async () => {
    const userId = await scalar("SELECT id FROM users WHERE username = 'student_a1'");
    const store = driveStore();
    await store.saveLink(userId, { externalId: "g-browse", login: "a1@example.com", clientId: "client-1", tokens: { accessToken: "ya29.b", scope: driveScope, accessExpiresAt: new Date(Date.now() + 3600e3) } });
    await store.addPicked(userId, [{ id: "rootFolder01", label: "ML Club", kind: "folder" }, { id: "singleFile01", label: "solo.py", kind: "file" }]);
    const fake = makeFakeDrive(sampleDriveTree());
    const drive = createGoogleDriveProvider({ store, settings: fakeGoogleSettings(), fetch: fake.fetch });
    try {
      const top = await drive.browse(userId, "rootFolder01", "");
      assert(top.root.label === "ML Club" && top.path === "" && JSON.stringify(top.items.map((i) => i.path)) === '["ML 2026","week3"]', `top ${JSON.stringify(top)}`);
      const spaced = await drive.browse(userId, "rootFolder01", " ML 2026 ");
      assert(spaced.path === "ML 2026" && spaced.items[0]?.name === "train.py", `folder with a space ${JSON.stringify(spaced)}`);
      const cnn = await drive.browse(userId, "rootFolder01", "/week3/cnn/");
      const names = cnn.items.map((i) => `${i.type}:${i.name}${i.native ? "*" : ""}`);
      assert(cnn.path === "week3/cnn" && JSON.stringify(names) === '["dir:data","dir:myenv","file:Plan*","file:requirements.txt","file:train.py"]', `cnn ${JSON.stringify(names)}`);
      assert(cnn.items.find((i) => i.name === "train.py").path === "week3/cnn/train.py", "item paths");
      const solo = await drive.browse(userId, "singleFile01", "");
      assert(solo.items.length === 1 && solo.items[0].name === "solo.py", `solo ${JSON.stringify(solo)}`);

      for (const [item, p, status] of [["outside00001", "", 403], ["rootFolder01", "../x", 400], ["rootFolder01", "week3/missing", 400], ["singleFile01", "sub", 400]]) {
        let got = 0;
        try { await drive.browse(userId, item, p); } catch (error) { got = error.status; }
        assert(got === status, `${item} ${p}: expected ${status}, got ${got}`);
      }
    } finally {
      await store.deleteLink(userId);
    }
  }],

  ["drive source: a chosen subfolder becomes the job's snapshot, with its files recorded", async () => {
    const userId = await scalar("SELECT id FROM users WHERE username = 'student_a1'");
    const store = driveStore();
    await store.saveLink(userId, { externalId: "g-src", login: "a1@example.com", clientId: "client-1", tokens: { accessToken: "ya29.s", scope: driveScope, accessExpiresAt: new Date(Date.now() + 3600e3) } });
    await store.addPicked(userId, [{ id: "rootFolder01", label: "ML Club", kind: "folder" }]);
    const fake = makeFakeDrive(sampleDriveTree());
    const provider = createGoogleDriveProvider({ store, settings: fakeGoogleSettings(), fetch: fake.fetch });
    const source = createDriveSource({ provider, fetch: fake.fetch });
    try {
      for (const bad of [{ itemId: "x" }, { itemId: "rootFolder01", path: "../up" }]) {
        let status = 0;
        try { source.parse(bad); } catch (error) { status = error.status; }
        assert(status === 400, `${JSON.stringify(bad)} should be 400`);
      }
      registerSource(source); // the registry's drive source, with the fakes
      const parsed = parseCodeSource({ source: { type: "drive", itemId: "rootFolder01", path: "week3/cnn" } });
      const { source: resolved, credential } = await resolveSourceAccess(userId, parsed);
      assert(credential === "ya29.s" && resolved.label === "ML Club/week3/cnn" && resolved.ref.folderId === "cnnFolder001", `resolved ${JSON.stringify(resolved)}`);

      const prepared = await prepareCodeSnapshot({ source: resolved, credential, folder: "", entryScript: "train.py" });
      try {
        const listing = execFileSync("tar", ["-tzf", prepared.archive]).toString();
        assert(/\.\/train\.py/.test(listing) && /\.\/data\/a\.csv/.test(listing) && !/week3|secret/.test(listing), `archive ${listing}`);
        assert(prepared.ref.fileCount === 6 && prepared.ref.files.length === 6 && prepared.ref.skipped.includes("Plan") && prepared.ref.itemId === "rootFolder01", `ref ${JSON.stringify(prepared.ref)}`);
      } finally {
        await rm(prepared.workDir, { recursive: true, force: true });
      }

      let message = "";
      try { await resolveSourceAccess(userId, parseCodeSource({ source: { type: "drive", itemId: "outside00001" } })); } catch (error) { message = `${error.status} ${error.message}`; }
      assert(/^403 /.test(message), `unpicked item: ${message}`);
    } finally {
      registerSource(createDriveSource());
      await store.deleteLink(userId);
    }
  }],

  ["local runner: a non-git source is fetched, committed as a baseline, run, and its changes reported", async () => {
    const adapter = createLocalExecutionAdapter();
    const ref = await adapter.start({
      name: "drive-local",
      sourceLabel: "ML Club/week3/cnn",
      fetchInput: async (dir) => {
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, "main.py"), "print('ran from drive')\nopen('made.txt', 'w').write('x')\n");
      },
      entryScript: "main.py",
      folder: "",
      maxRuntimeSeconds: 60,
    });
    await waitFor(async () => ["completed", "failed"].includes((await adapter.getStatus(ref)).state), { timeoutMs: 30000 });
    const status = await adapter.getStatus(ref);
    const logs = (await adapter.getLogs(ref)).lines.join("\n");
    assert(status.state === "completed", `state ${status.state}\n${logs}`);
    assert(/Copying ML Club\/week3\/cnn/.test(logs) && /ran from drive/.test(logs), `logs ${logs}`);
    const files = await adapter.listOutputFiles(ref);
    assert(files.some((f) => f.name === "made.txt" && f.source === "repo_changed") && !files.some((f) => f.name === "main.py"), `outputs ${JSON.stringify(files)}`);

    // Cancelled while copying: the copy stops and the script never runs.
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const slow = await adapter.start({
      name: "drive-cancel",
      fetchInput: async (dir, { signal }) => {
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, "main.py"), "open('ran.txt', 'w').write('should not run')\n");
        await gate;
        if (signal.aborted) throw new Error("Cancelled");
      },
      entryScript: "main.py",
      folder: "",
    });
    await waitFor(async () => (await adapter.getLogs(slow)).lines.some((l) => /Copying/.test(l)), { timeoutMs: 10000 });
    const cancelReply = await adapter.cancel(slow);
    release();
    await waitFor(async () => (await adapter.getStatus(slow)).state === "cancelled", { timeoutMs: 10000 });
    assert(cancelReply.state === "cancelling" && /Cancelled while copying/.test((await adapter.getLogs(slow)).lines.join("\n")), `cancel ${JSON.stringify(cancelReply)}`);
    assert(!(await adapter.listOutputFiles(slow)).some((f) => f.name === "ran.txt"), "the script must not run after a cancel");

    const broken = await adapter.start({ name: "drive-broken", fetchInput: async () => { throw new Error("Drive said no"); }, entryScript: "main.py", folder: "" });
    await waitFor(async () => (await adapter.getStatus(broken)).state === "failed", { timeoutMs: 10000 });
    assert(/Could not copy the code: Drive said no/.test((await adapter.getLogs(broken)).lines.join("\n")), "fetch failure is reported");
  }],

  ["connections registry: describes every provider, configured or not", async () => {
    const fake = (id, configured, link) => ({
      id, label: id.toUpperCase(), auth: "oauth", roles: ["code"],
      status: async () => ({ configured }), getLink: async () => link,
    });
    const registry = createConnectionRegistry([fake("one", false, null), fake("two", true, { login: "me", linkedAt: "t", needsReconnect: true })]);
    const [one, two] = await registry.describeFor("u");
    assert(one.configured === false && one.linked === false && one.account === null, `one ${JSON.stringify(one)}`);
    assert(two.linked && two.account.login === "me" && two.needsReconnect, `two ${JSON.stringify(two)}`);
    assert(registry.get("two") && registry.get("nope") === null, "get by id");
  }],

  ["sources: github parses URLs and defaults; unknown types and bad input are 400", async () => {
    const parsed = parseCodeSource({ source: { type: "github", repo: "https://github.com/Owner/Repo.git" } });
    assert(parsed.type === "github" && parsed.label === "Owner/Repo" && parsed.ref.branch === "main" && parsed.ref.host === "github.com", `parsed ${JSON.stringify(parsed)}`);
    assert(parseCodeSource({ repo: "a/b", branch: "dev" }).ref.branch === "dev", "top-level repo/branch mean GitHub");
    for (const payload of [{ source: { type: "nope" } }, { repo: "" }, { repo: "a/b", branch: "-x" }, { repo: "a/b", branch: "a..b" }]) {
      let status = 0;
      try { parseCodeSource(payload); } catch (error) { status = error.status; }
      assert(status === 400, `${JSON.stringify(payload)} should be 400, got ${status}`);
    }
    assert(getSourceType("github").runners.includes("ec2") && getSourceType("github").connection === "github", "github source metadata");
    const { normalizeDrivePath } = await import("talon-shared/repo");
    for (const [input, expected] of [["", ""], ["/ML 2026/week 3/", "ML 2026/week 3"], ["a//b", null], ["a/../b", null], ["./x", null], ["a\\b", null], ["tab\there", null]]) {
      assert(normalizeDrivePath(input) === expected, `normalizeDrivePath(${JSON.stringify(input)}) = ${JSON.stringify(normalizeDrivePath(input))}`);
    }
  }],

  ["snapshots: symlinks out of the tree, special files and size limits are refused", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "talon-snap-"));
    try {
      const code = path.join(dir, "code");
      await mkdir(path.join(code, "sub"), { recursive: true });
      await writeFile(path.join(code, "train.py"), "print('hi')\n");
      await symlink("../train.py", path.join(code, "sub", "inside.py"));
      const packed = await packSnapshot(code, path.join(dir, "a.tgz"));
      assert(packed.bytes > 0 && /^[0-9a-f]{64}$/.test(packed.sha256) && packed.files === 3, `packed ${JSON.stringify(packed)}`);
      const listing = execFileSync("tar", ["-tzf", path.join(dir, "a.tgz")]).toString();
      assert(/train\.py/.test(listing) && /sub\/inside\.py/.test(listing), `archive listing ${listing}`);

      const refuse = async (setup, pattern, limits) => {
        const tree = await mkdtemp(path.join(dir, "t-"));
        await setup(tree);
        let message = "";
        try { await checkTree(tree, { maxFiles: 100, maxUnpackedBytes: 1000, ...limits }); } catch (error) { message = error.message; }
        assert(pattern.test(message), `expected ${pattern}, got "${message}"`);
      };
      await refuse((t) => symlink("/etc/passwd", path.join(t, "p")), /links outside/);
      await refuse((t) => symlink("../../x", path.join(t, "up")), /links outside/);
      await refuse((t) => writeFile(path.join(t, "big"), "x".repeat(2000)), /larger than .*biggest files: big \(2\.0 KB\)/);

      // Packed over the limit: the error names the biggest files.
      const { randomBytes } = await import("node:crypto");
      const media = path.join(dir, "media");
      await mkdir(media);
      await writeFile(path.join(media, "train.py"), "print(1)\n");
      await writeFile(path.join(media, "Niagara 01.mp4"), randomBytes(4096));
      let packError = "";
      try { await packSnapshot(media, path.join(dir, "m.tgz"), { maxFiles: 100, maxUnpackedBytes: 1e6, maxBytes: 1024 }); } catch (error) { packError = error.message; }
      assert(/packed .*biggest files: Niagara 01\.mp4 \(4\.0 KB\), train\.py/.test(packError) && /Move large data/.test(packError), `pack error: ${packError}`);
      await refuse(async (t) => { for (const n of [1, 2, 3]) await writeFile(path.join(t, `f${n}`), ""); }, /more than 2 files/, { maxFiles: 2 });
      await refuse((t) => { execFileSync("mkfifo", [path.join(t, "fifo")]); }, /not a regular file/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }],

  ["sources: prepareCodeSnapshot fetches, checks the entry script and packs", async () => {
    registerSource({
      type: "testdir", label: "Test folder", roles: ["code"], connection: null, runners: ["ec2"],
      parse: (input) => ({ files: input.files }), describe: () => "test",
      resolveAccess: async () => "cred-1",
      async fetchInto(ref, dir, credential) {
        await mkdir(path.join(dir, "src"), { recursive: true });
        for (const [name, body] of Object.entries(ref.files)) await writeFile(path.join(dir, name), body);
        return { fetchedWith: credential };
      },
    });
    const source = { type: "testdir", ref: { files: { "src/main.py": "print(1)" } } };
    const ok = await prepareCodeSnapshot({ source, credential: "cred-1", folder: "src", entryScript: "main.py" });
    try {
      assert(ok.bytes > 0 && /^[0-9a-f]{64}$/.test(ok.sha256) && ok.ref.fetchedWith === "cred-1" && ok.ref.files, `prepared ${JSON.stringify({ ...ok, archive: undefined })}`);
    } finally {
      await rm(ok.workDir, { recursive: true, force: true });
    }
    let message = "";
    try { await prepareCodeSnapshot({ source, folder: "", entryScript: "missing.py" }); } catch (error) { message = `${error.status} ${error.message}`; }
    assert(/^400 Entry script not found: missing\.py/.test(message), message);
    message = "";
    try { await prepareCodeSnapshot({ source, folder: "", entryScript: "../../etc/passwd" }); } catch (error) { message = `${error.status} ${error.message}`; }
    assert(/^400 .*escapes/.test(message), message);
    const left = (await readdir(os.tmpdir())).filter((n) => n.startsWith("talon-input-"));
    assert(left.length === 0, `work folders left behind: ${left}`);
  }],

  ["git fetcher: shallow clone of one branch, records the commit, drops .git", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "talon-git-"));
    const saved = { count: process.env.GIT_CONFIG_COUNT, key: process.env.GIT_CONFIG_KEY_0, value: process.env.GIT_CONFIG_VALUE_0 };
    try {
      const work = path.join(dir, "work");
      const git = (...args) => execFileSync("git", args, { cwd: work, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } }).toString().trim();
      await mkdir(work);
      git("init", "-q", "-b", "dev");
      await writeFile(path.join(work, "train.py"), "print(1)\n");
      git("add", ".");
      git("commit", "-qm", "one");
      const commit = git("rev-parse", "HEAD");
      execFileSync("git", ["clone", "-q", "--bare", work, path.join(dir, "owner", "repo.git")]);

      // Point https://github.com/ at the local folder for this clone only.
      process.env.GIT_CONFIG_COUNT = "1";
      process.env.GIT_CONFIG_KEY_0 = `url.file://${dir}/.insteadOf`;
      process.env.GIT_CONFIG_VALUE_0 = "https://github.com/";
      const target = path.join(dir, "out");
      const result = await cloneInto({ host: "github.com", repoPath: "owner/repo", branch: "dev", dir: target });
      assert(result.commit === commit, `commit ${result.commit} != ${commit}`);
      const files = await readdir(target);
      assert(files.includes("train.py") && !files.includes(".git"), `cloned files ${files}`);

      let message = "";
      try { await cloneInto({ host: "github.com", repoPath: "owner/repo", branch: "nope", dir: path.join(dir, "out2") }); } catch (error) { message = `${error.status} ${error.message}`; }
      assert(/^400 Could not clone owner\/repo@nope/.test(message), message);
      let hostError = "";
      try { await cloneInto({ host: "evil host", repoPath: "a/b", branch: "main", dir: path.join(dir, "out3") }); } catch (error) { hostError = error.message; }
      assert(/host is invalid/.test(hostError), hostError);
    } finally {
      for (const [name, value] of [["GIT_CONFIG_COUNT", saved.count], ["GIT_CONFIG_KEY_0", saved.key], ["GIT_CONFIG_VALUE_0", saved.value]]) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
      await rm(dir, { recursive: true, force: true });
    }
  }],

  ["git auth: token is sent only to the source's host", async () => {
    assert(gitAuthEnv("tok", "gitlab.com").GIT_CONFIG_KEY_0 === "http.https://gitlab.com/.extraheader", "host in the config key");
    assert(gitAuthEnv("tok").GIT_CONFIG_KEY_0 === "http.https://github.com/.extraheader", "GitHub by default");
    let refused = false;
    try { gitAuthEnv("tok", "github.com/.extraheader x"); } catch { refused = true; }
    assert(refused, "a host with a path must be refused");
  }],

  ["storage keys: per-user prefixes by id, launch folders", async () => {
    const id = "0B1C2D3E-1111-4222-8333-444455556666";
    assert(userPrefix(id) === "users/0b1c2d3e-1111-4222-8333-444455556666/" && userHomePrefix(id).endsWith("/home/"), "user prefix");
    for (const bad of ["jane_smith", "../x", ""]) {
      let refused = false;
      try { userPrefix(bad); } catch { refused = true; }
      assert(refused, `user prefix for ${JSON.stringify(bad)} must be refused`);
    }
    assert(jobLaunchPrefix("job-7", "0123456789abcdef") === "jobs/job-7-0123456789abcdef", "launch prefix");
  }],

  ["ec2 jobs: the code input records its snapshot and commit; a failure to record does not fail the job", async () => {
    const jobs = createJobsPostgresRepository({ pool });
    const owner = await scalar("SELECT id FROM users WHERE username = 'admin'");
    const user = { id: owner, username: "admin" };
    const sha = "a".repeat(64);
    const commit = "b".repeat(40);
    const adapter = {
      async start(spec) {
        assert(spec.source.type === "github" && spec.source.ref.repo === "o/r" && spec.credential === "inst-token", `spec ${JSON.stringify(spec.source)} ${spec.credential}`);
        return { provider: "ec2", executionId: spec.jobId, jobId: spec.jobId, instanceId: "i-snap", input: { snapshotKey: "jobs/x/input/repo.tgz", sha256: sha, bytes: 1234, ref: { ...spec.source.ref, commit } } };
      },
    };
    const job = await launchEc2Job({
      jobsRepository: jobs, adapter, user, isAdmin: true, credential: "inst-token",
      payload: { name: "snap", source: { type: "github", repo: "o/r", branch: "dev" }, instanceType: "c7g.large" },
    });
    assert(job.executionRef.instanceId === "i-snap" && job.executionRef.input === undefined, `execution ref ${JSON.stringify(job.executionRef)}`);
    assert(job.source.ref.commit === commit && job.source.ref.branch === "dev" && job.source.snapshot.sha256 === sha && job.source.snapshot.bytes === 1234, `source ${JSON.stringify(job.source)}`);
    assert((await scalar("SELECT snapshot_key FROM job_inputs WHERE job_id = $1", [job.id])) === "jobs/x/input/repo.tgz", "snapshot key stored");
    const report = (await pool.query("SELECT source_type, source_label, repo, branch, commit, input_bytes FROM reporting.jobs WHERE id = $1", [job.id])).rows[0];
    assert(report.source_type === "github" && report.source_label === "o/r" && report.repo === "o/r" && report.commit === commit && Number(report.input_bytes) === 1234, `reporting ${JSON.stringify(report)}`);

    const flaky = { ...jobs, async recordInputSnapshot() { throw new Error("db hiccup"); } };
    const stillRunning = await launchEc2Job({ jobsRepository: flaky, adapter, user, isAdmin: true, credential: "inst-token", payload: { name: "snap2", repo: "o/r", instanceType: "c7g.large" } });
    assert(stillRunning.status === "running" && stillRunning.executionRef.instanceId === "i-snap", `job after a failed record: ${stillRunning.status}`);
  }],

  ["ec2 jobs: submit returns at once; the launch runs in the background and records its progress", async () => {
    const savedLimit = process.env.EC2_MAX_JOBS_TOTAL;
    process.env.EC2_MAX_JOBS_TOTAL = "1000"; // earlier tests leave unfinished EC2 jobs
    try {
    const jobs = createJobsPostgresRepository({ pool });
    const owner = await scalar("SELECT id FROM users WHERE username = 'admin'");
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const adapter = {
      async start(spec) {
        spec.onProgress("Found 584 files (12 MB) in 9 folders");
        await gate;
        return { provider: "ec2", executionId: spec.jobId, jobId: spec.jobId, instanceId: "i-bg", instanceType: "c7g.large" };
      },
    };
    const { job, launch } = await startEc2Job({ jobsRepository: jobs, adapter, user: { id: owner, username: "admin" }, isAdmin: true, payload: { name: "bg", repo: "o/r", instanceType: "c7g.large" } });
    assert(job.status === "running" && !job.executionRef && job.reservedCents > 0, `submitted job ${JSON.stringify(job)}`);
    await waitFor(async () => (await jobs.findById(job.id)).launch?.progress?.startsWith("Found 584"), { timeoutMs: 5000 });
    release();
    const launched = await launch;
    assert(launched.executionRef?.instanceId === "i-bg", `launched ${JSON.stringify(launched.executionRef)}`);
    // Progress is only kept while preparing; later writes are ignored.
    await jobs.setLaunchProgress(job.id, "late");
    assert((await jobs.findById(job.id)).launch.progress !== "late", "progress must not change after launch");

    // A launch that fails ends the job as failed with the reason, refunded.
    const failing = await startEc2Job({ jobsRepository: jobs, adapter: { async start() { throw Object.assign(new Error("Folder is larger than 100 MB"), { status: 400 }); } }, user: { id: owner, username: "admin" }, isAdmin: true, payload: { name: "bg-fail", repo: "o/r", instanceType: "c7g.large" } });
    const ended = await failing.launch;
    assert(ended.status === "failed" && ended.costCents === 0, `failed launch ${ended.status} ${ended.costCents}`);
    assert(/larger than 100 MB/.test((await pool.query("SELECT error FROM results WHERE job_id = $1", [ended.id])).rows[0].error), "the reason is kept");
    assert(/^Could not start the job: Folder is larger than 100 MB/.test(ended.error || "") && (await jobs.findById(ended.id)).error === ended.error, `the job carries the reason: ${ended.error}`);
    } finally {
      if (savedLimit === undefined) delete process.env.EC2_MAX_JOBS_TOTAL; else process.env.EC2_MAX_JOBS_TOTAL = savedLimit;
    }
  }],

  ["ec2 jobs: cancelling while preparing starts nothing and refunds once", async () => {
    const savedLimit = process.env.EC2_MAX_JOBS_TOTAL;
    process.env.EC2_MAX_JOBS_TOTAL = "1000"; // earlier tests leave unfinished EC2 jobs
    try {
    const jobs = createJobsPostgresRepository({ pool });
    const owner = await scalar("SELECT id FROM users WHERE username = 'admin'");
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let ranInstances = false;
    const adapter = {
      async start(spec) {
        await gate;
        if (await spec.isCancelled()) {
          throw Object.assign(new Error("Cancelled before an instance was started"), { status: 499 });
        }
        ranInstances = true;
        return { provider: "ec2", executionId: spec.jobId, jobId: spec.jobId, instanceId: "i-no" };
      },
    };
    const { job, launch } = await startEc2Job({ jobsRepository: jobs, adapter, user: { id: owner, username: "admin" }, isAdmin: true, payload: { name: "bg-cancel", repo: "o/r", instanceType: "c7g.large" } });
    // What the cancel route does for a job still being prepared.
    await jobs.finalize(job.id, { syncKey: "cancelled-before-launch", status: "failed", neverRan: true, error: "Cancelled before it started", finalizedAt: new Date().toISOString() });
    release();
    const ended = await launch;
    assert(!ranInstances && !ended.executionRef && ended.status === "failed" && ended.resultSyncKey === "cancelled-before-launch", `after cancel ${JSON.stringify({ ranInstances, ref: ended.executionRef, key: ended.resultSyncKey })}`);
    const refunds = (await pool.query("SELECT count(*)::int AS n FROM budget_ledger WHERE job_id = $1 AND kind = 'refund'", [job.id])).rows[0].n;
    assert(refunds === 1 && ended.costCents === 0, `refunds ${refunds}, cost ${ended.costCents}`);
    } finally {
      if (savedLimit === undefined) delete process.env.EC2_MAX_JOBS_TOTAL; else process.env.EC2_MAX_JOBS_TOTAL = savedLimit;
    }
  }],

  ["ec2 adapter: a job cancelled while its code was prepared never reaches RunInstances; progress is reported", async () => {
    const aws = makeFakeAws();
    const progress = [];
    const adapter = createEc2ExecutionAdapter({
      ec2: aws.ec2, s3: aws.s3,
      config: { bucket: "b", launchTemplateId: "lt-1", subnetIds: ["subnet-ok"] },
      prepareInput: async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), "talon-test-"));
        await writeFile(path.join(dir, "repo.tgz"), "archive-bytes");
        return { workDir: dir, archive: path.join(dir, "repo.tgz"), bytes: 2048 };
      },
      newLaunchId: () => "fedcba9876543210fedcba9876543210",
    });
    const spec = { jobId: "job-c1", entryScript: "train.py", maxRuntimeSeconds: 600, instanceType: "c7g.large", ownerUsername: "admin", onProgress: (t) => progress.push(t) };
    let message = "";
    try { await adapter.start({ ...spec, isCancelled: async () => true }); } catch (error) { message = `${error.status} ${error.message}`; }
    assert(/^499 Cancelled/.test(message) && !aws.calls.some((c) => c.name === "RunInstancesCommand"), `cancelled launch: ${message}`);
    await adapter.start({ ...spec, jobId: "job-c2", isCancelled: async () => false });
    assert(progress.some((t) => /Uploading the code to S3 \(2.0 KB\)/.test(t)) && progress.includes("Starting a c7g.large instance"), `progress ${JSON.stringify(progress)}`);
  }],

  ["ec2 reconciler: a launch with no progress for 10 minutes fails and is refunded; a recent one is left alone", async () => {
    const jobs = createJobsPostgresRepository({ pool });
    const owner = await scalar("SELECT id FROM users WHERE username = 'admin'");
    const mk = (name) => jobs.createWithReservation({ ownerUserId: owner, name, repo: "x/y", executionProvider: "ec2", hourlyRateCents: 360, maxRuntimeSeconds: 100, reserveCents: 5, enforceBalance: false });
    const stale = await mk("prep-stale");
    const fresh = await mk("prep-fresh");
    await pool.query("UPDATE jobs SET launch_progress_at = now() - interval '11 minutes', launch_progress = 'Copied 3 of 9 files' WHERE id = $1", [stale.id]);
    const warned = [];
    const synced = [];
    const reconciler = createEc2Reconciler({
      jobsRepository: jobs,
      adapter: { async listJobInstances() { return []; }, async terminateInstance() {} },
      sync: async (job) => synced.push(job.id),
      markLost: async () => {},
      log: { info() {}, warn(msg, fields) { warned.push(fields); }, error() {} },
    });
    await reconciler.tick();
    const staleNow = await jobs.findById(stale.id);
    const freshNow = await jobs.findById(fresh.id);
    assert(staleNow.status === "failed" && staleNow.resultSyncKey === "launch-interrupted" && staleNow.costCents === 0, `stale ${staleNow.status} ${staleNow.resultSyncKey}`);
    assert(freshNow.status === "running" && !freshNow.resultSyncKey, `fresh ${freshNow.status}`);
    assert(!synced.includes(stale.id) && !synced.includes(fresh.id), "jobs being prepared are not synced");
    assert(warned.some((w) => w.event === "ec2.launch_interrupted" && w.jobId === stale.id && w.lastProgress === "Copied 3 of 9 files"), `warn ${JSON.stringify(warned)}`);
    await jobs.finalize(fresh.id, { syncKey: "cleanup", status: "failed", neverRan: true });
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
      newLaunchId: () => "0123456789abcdef0123456789abcdef",
    });
    const ref = await adapter.start({ jobId: "job-7", repo: "a/b", branch: "main", entryScript: "train.py", maxRuntimeSeconds: 600, instanceType: "c7g.large", ownerUsername: "admin" });
    const folder = "jobs/job-7-0123456789abcdef0123456789abcdef";
    assert(ref.instanceId === "i-abc" && ref.subnetId === "subnet-ok" && ref.executionId === "job-7" && ref.s3Prefix === folder, `ref ${JSON.stringify(ref)}`);
    assert(aws.objects.get(`${folder}/input/repo.tgz`) === "archive-bytes", "repo.tgz not uploaded");
    assert(ref.input?.snapshotKey === `${folder}/input/repo.tgz`, `snapshot key reported: ${JSON.stringify(ref.input)}`);
    assert(/exec python3 -u 'train.py'/.test(aws.objects.get(`${folder}/input/run.sh`)), "run.sh not uploaded");
    assert(![...aws.objects.keys()].some((k) => k.startsWith("jobs/job-7/")), "nothing goes to the id-only folder");
    const run = aws.calls.filter((c) => c.name === "RunInstancesCommand").at(-1).input;
    const tags = Object.fromEntries(run.TagSpecifications[0].Tags.map((t) => [t.Key, t.Value]));
    assert(tags.Project === "talon" && tags.Component === "job" && tags["talon-job"] === "job-7" && tags["talon-max-seconds"] === "600" && tags["talon-s3-prefix"] === folder, `tags ${JSON.stringify(tags)}`);
    assert(run.InstanceType === "c7g.large" && run.ClientToken === "talon-0123456789abcdef0123456789abcdef-subnet-ok", `type or client token wrong: ${run.ClientToken}`);

    let refused = "";
    try { await adapter.start({ jobId: "job-8", instanceType: "p5.48xlarge", maxRuntimeSeconds: 60 }); } catch (e) { refused = e.message; }
    assert(/not allowed/.test(refused), `unknown type: ${refused}`);
  }],

  ["ec2 adapter: a reused job id gets its own folder and never sees an older job's status or files", async () => {
    const aws = makeFakeAws();
    const prepareInput = async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "talon-test-"));
      await writeFile(path.join(dir, "repo.tgz"), "x");
      return { workDir: dir, archive: path.join(dir, "repo.tgz") };
    };
    const adapter = createEc2ExecutionAdapter({ ec2: aws.ec2, s3: aws.s3, prepareInput, config: { bucket: "b", launchTemplateId: "lt-1", subnetIds: ["subnet-ok"] } });

    // An older job-49 (another database, before per-launch folders) left its result behind.
    aws.objects.set("jobs/job-49/status.json", JSON.stringify({ state: "succeeded", exit_code: 0, updated_at: "2026-10-27T23:09:03Z" }));
    aws.objects.set("jobs/job-49/logs/job.log", "someone else's log\n");
    aws.objects.set("jobs/job-49/output/secret.txt", "someone else's output");

    const spec = { jobId: "job-49", repo: "a/b", entryScript: "train.py", maxRuntimeSeconds: 600, instanceType: "c7g.large" };
    const first = await adapter.start(spec);
    const second = await adapter.start(spec);
    assert(/^jobs\/job-49-[a-f0-9]{32}$/.test(first.s3Prefix), `folder ${first.s3Prefix}`);
    assert(first.s3Prefix !== second.s3Prefix, "two launches share a folder");
    const tokens = aws.calls.filter((c) => c.name === "RunInstancesCommand").map((c) => c.input.ClientToken);
    assert(tokens.length === 2 && tokens[0] !== tokens[1] && !tokens.some((t) => t.includes("job-49")), `client tokens ${tokens}`);

    const status = await adapter.getStatus(first);
    assert(status.state !== "completed" && !String(status.syncKey || "").startsWith("status:"), `old status leaked: ${JSON.stringify(status)}`);
    assert((await adapter.getLogs(first)).lines.length === 0, "old log leaked");
    assert((await adapter.listOutputFiles(first)).length === 0, "old output leaked");
    let missing = "";
    try { await adapter.openOutputFile(first, "secret.txt"); } catch (e) { missing = e.message; }
    assert(/not found/i.test(missing), `old file readable: ${missing}`);

    // A ref without its own folder, or with a malformed one, is refused: never
    // the bare id folder (another job's), never anywhere else.
    const noFolder = { jobId: "job-49", instanceId: "i-old", maxRuntimeSeconds: 600, launchedAt: "2026-10-27T23:00:00Z" };
    for (const ref of [noFolder, { ...noFolder, s3Prefix: "jobs/../other" }]) {
      let refused = "";
      try { await adapter.getLogs(ref); } catch (e) { refused = e.message; }
      assert(/no valid S3 folder/.test(refused), `ref without a valid folder was read: ${JSON.stringify(ref)} ${refused}`);
    }
  }],

  ["ec2 adapter: moves on when a zone does not offer the type, rotates the first subnet, stops on other errors", async () => {
    const aws = makeFakeAws();
    const prepareInput = async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "talon-test-"));
      await writeFile(path.join(dir, "repo.tgz"), "x");
      return { workDir: dir, archive: path.join(dir, "repo.tgz") };
    };
    const adapter = createEc2ExecutionAdapter({
      ec2: aws.ec2, s3: aws.s3, prepareInput,
      config: { bucket: "b", launchTemplateId: "lt-1", subnetIds: ["subnet-not-offered", "subnet-a", "subnet-b"] },
    });
    const spec = (jobId) => ({ jobId, repo: "a/b", entryScript: "train.py", maxRuntimeSeconds: 600, instanceType: "c7g.large" });
    const launched = [];
    for (const id of ["r1", "r2", "r3"]) launched.push((await adapter.start(spec(id))).subnetId);
    assert(JSON.stringify(launched) === JSON.stringify(["subnet-a", "subnet-a", "subnet-b"]), `subnets ${launched}`);
    const tried = aws.calls.filter((c) => c.name === "RunInstancesCommand").map((c) => c.input.SubnetId);
    assert(JSON.stringify(tried) === JSON.stringify(["subnet-not-offered", "subnet-a", "subnet-a", "subnet-b"]), `tried ${tried}`);

    const strict = createEc2ExecutionAdapter({
      ec2: aws.ec2, s3: aws.s3, prepareInput,
      config: { bucket: "b", launchTemplateId: "lt-1", subnetIds: ["subnet-denied", "subnet-a"] },
    });
    let message = "";
    try { await strict.start(spec("r4")); } catch (e) { message = e.message; }
    assert(/UnauthorizedOperation/.test(message), `a permission error must not try other subnets: ${message}`);

    const full = createEc2ExecutionAdapter({
      ec2: aws.ec2, s3: aws.s3, prepareInput,
      config: { bucket: "b", launchTemplateId: "lt-1", subnetIds: ["subnet-full", "subnet-not-offered"] },
    });
    let refusal = null;
    try { await full.start(spec("r5")); } catch (e) { refusal = e; }
    assert(refusal?.status === 503, `no capacity anywhere: expected 503, got ${refusal?.status}`);
    assert(refusal.message === "No c7g.large machines are available right now (AWS has no capacity in all 2 zones Talon uses). Try again later or choose another machine.", `message: ${refusal.message}`);
  }],

  ["ec2 adapter: GPU types launch from their own template with a matching run.sh", async () => {
    const aws = makeFakeAws();
    const prepareInput = async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "talon-test-"));
      await writeFile(path.join(dir, "repo.tgz"), "x");
      return { workDir: dir, archive: path.join(dir, "repo.tgz") };
    };
    const config = { bucket: "b", launchTemplateId: "lt-cpu", launchTemplateIds: { gpu: "lt-gpu" }, subnetIds: ["subnet-a"] };
    const adapter = createEc2ExecutionAdapter({ ec2: aws.ec2, s3: aws.s3, prepareInput, config });
    const spec = (jobId, instanceType) => ({ jobId, repo: "a/b", entryScript: "train.py", maxRuntimeSeconds: 600, instanceType });
    const template = () => aws.calls.filter((c) => c.name === "RunInstancesCommand").at(-1).input.LaunchTemplate.LaunchTemplateId;

    const cpuRef = await adapter.start(spec("c1", "m7g.large"));
    assert(template() === "lt-cpu", `cpu template ${template()}`);
    assert(!aws.objects.get(`${cpuRef.s3Prefix}/input/run.sh`).includes("/opt/pytorch"), "cpu run.sh must not use the DLAMI python");

    const gpuRef = await adapter.start(spec("g1", "g4dn.xlarge"));
    assert(template() === "lt-gpu", `gpu template ${template()}`);
    const gpuRun = aws.objects.get(`${gpuRef.s3Prefix}/input/run.sh`);
    assert(gpuRun.includes("DLAMI_PY=/opt/pytorch/bin/python3") && gpuRun.includes("talon-dlami.pth") && gpuRun.includes(". /work/venv/bin/activate"), "gpu run.sh must build a venv on the DLAMI's torch");
    assert(gpuRun.indexOf("talon-dlami.pth") < gpuRun.indexOf("REQS="), "venv must exist before requirements are installed");

    await adapter.start(spec("g3", "g6e.2xlarge"));
    assert(template() === "lt-gpu", `g6e template ${template()}`);

    const noGpu = createEc2ExecutionAdapter({ ec2: aws.ec2, s3: aws.s3, prepareInput, config: { ...config, launchTemplateIds: { gpu: null } } });
    let status = 0;
    try { await noGpu.start(spec("g2", "g4dn.xlarge")); } catch (e) { status = e.status; }
    assert(status === 503, `GPU without its template: expected 503, got ${status}`);
  }],

  ["ec2 rates: per-type time limit ceilings, boot allowance and GPU options", async () => {
    assert(isAllowedRuntime(86400, "g4dn.xlarge") && !isAllowedRuntime(43200, "g6e.2xlarge") && isAllowedRuntime(28800, "g6e.2xlarge"), "g6e.2xlarge ceiling is 8 h");
    process.env.EC2_MAX_RUNTIME_CEILING_SECONDS_G6E_2XLARGE = "7200";
    try {
      assert(!isAllowedRuntime(14400, "g6e.2xlarge") && isAllowedRuntime(7200, "g6e.2xlarge"), "per-type ceiling setting");
    } finally {
      delete process.env.EC2_MAX_RUNTIME_CEILING_SECONDS_G6E_2XLARGE;
    }
    process.env.JOB_BOOT_ALLOWANCE_SECONDS = "600";
    try {
      assert(bootAllowanceSeconds("g6e.2xlarge") === 600 && bootAllowanceSeconds() === 600, "boot allowance setting");
      const rate = hourlyRateCentsFor("g6e.2xlarge");
      assert(reservationCentsFor(rate, 3600, "g6e.2xlarge") === Math.ceil((rate * 4200) / 3600), "reservation adds the boot allowance");
    } finally {
      delete process.env.JOB_BOOT_ALLOWANCE_SECONDS;
    }
    assert(bootAllowanceSeconds("g4dn.xlarge") === 300, "default boot allowance");
    assert(imageFor("g4dn.xlarge") === "gpu" && imageFor("g6e.2xlarge") === "gpu" && imageFor("c7g.large") === "cpu", "images");
    const cpuOnly = listInstanceOptions({ includeGpu: false });
    assert(cpuOnly.length > 0 && !cpuOnly.some((o) => o.gpu), "includeGpu false hides GPU types");
  }],

  ["ec2 jobs: GPU machines are admin-only by default and capped together", async () => {
    const jobs = createJobsPostgresRepository({ pool });
    const adapter = { async start(spec) { return { provider: "ec2", executionId: spec.jobId, jobId: spec.jobId, instanceId: `i-${spec.jobId}` }; } };
    const finishAll = async () => {
      const open = await pool.query("SELECT id FROM jobs WHERE execution_provider = 'ec2' AND status IN ('queued', 'running')");
      for (const row of open.rows) await jobs.finalize(row.id, { syncKey: "test-done", status: "failed", neverRan: true, error: "test cleanup" });
    };
    await finishAll();
    const student = { id: await scalar("SELECT id FROM users WHERE username = 'student_a1'"), username: "student_a1" };
    const admin = { id: await scalar("SELECT id FROM users WHERE username = 'admin'"), username: "admin" };
    const launch = (user, isAdmin, instanceType = "g4dn.xlarge") => launchEc2Job({ jobsRepository: jobs, adapter, user, isAdmin, payload: { name: "gpu-cap", repo: "x/y", instanceType, maxRuntimeSeconds: 1800 } });

    let status = 0;
    try { await launch(student, false); } catch (e) { status = e.status; }
    assert(status === 403, `student GPU launch: expected 403, got ${status}`);

    for (let i = 0; i < 3; i += 1) await launch(admin, true);
    let code = "";
    try { await launch(admin, true, "g6.xlarge"); } catch (e) { code = e.code; }
    assert(code === "group_limit", `4th GPU job: expected group_limit, got ${code}`);
    await launch(admin, true, "c7g.large"); // CPU jobs are not held back by the GPU cap
    await finishAll();
  }],

  ["ec2 adapter: entry script and branch cannot inject shell", async () => {
    for (const bad of ["x.py; rm -rf /", "$(id).py", "../../etc/passwd", "a b.py", "'quote.py", "-rf"]) {
      let refused = false;
      try { assertEntryScript(bad); } catch { refused = true; }
      assert(refused, `entry script ${JSON.stringify(bad)} must be refused`);
    }
    assert(buildRunScript("a.py").includes("PYTHONUNBUFFERED=1"), "output must not be buffered");
    assert(buildRunScript("a.py").includes("export TALON_SCRATCH_DIR=/work/scratch"), "scripts get a scratch directory");
    assert(buildRunScript("src/train_1.py").includes("python3 -u 'src/train_1.py'"), "plain paths must pass");
  }],

  ["script arguments: parsed like a shell, never expanded", async () => {
    const same = (text, expected) => {
      const got = parseScriptArgs(text);
      assert(JSON.stringify(got) === JSON.stringify(expected), `${JSON.stringify(text)} -> ${JSON.stringify(got)}`);
    };
    same("", []);
    same("  --save-model   --epochs 3 ", ["--save-model", "--epochs", "3"]);
    same(`--name "my run" --note 'it''s'`, ["--name", "my run", "--note", "its"]);
    same(String.raw`--msg "say \"hi\""`, ["--msg", 'say "hi"']);
    same(String.raw`a\ b`, ["a b"]);
    same(`--x=$(id) $HOME *.py`, ["--x=$(id)", "$HOME", "*.py"]);
    same(`--empty ""`, ["--empty", ""]);
    for (const bad of [`--a "open`, "line\none".replace("\\n", "\n"), "x".repeat(2001)]) {
      let refused = false;
      try { parseScriptArgs(bad); } catch (e) { refused = e.status === 400; }
      assert(refused, `should refuse ${JSON.stringify(bad).slice(0, 40)}`);
    }
    const script = buildRunScript("main.py", [], "mnist", ["--save-model", "it's $(id)"]);
    assert(script.includes(`exec python3 -u 'main.py' '--save-model' 'it'\\''s $(id)'`), `run.sh line: ${script.split("\n").find((l) => l.startsWith("exec"))}`);
  }],

  ["ec2 adapter: a job folder sets the working directory and requirements", async () => {
    const root = buildRunScript("train.py");
    assert(root.includes("cd '/work/repo' ||"), "no folder runs from the repo root");
    const nested = buildRunScript("main.py", [], "mnist");
    assert(nested.includes("cd '/work/repo/mnist' ||"), "folder must be the working directory");
    assert(nested.includes("if [ -f requirements.txt ]; then REQS=requirements.txt; elif [ -f /work/repo/requirements.txt ]"), "folder requirements first, then the root's");
    assert(nested.includes("exec python3 -u 'main.py'"), "entry script is relative to the folder");
    for (const bad of ["../etc", "a/../../b", "x'; id; '", "a b", "/abs/../.."]) {
      let refused = false;
      try { buildRunScript("main.py", [], bad); } catch { refused = true; }
      assert(refused, `folder ${JSON.stringify(bad)} must be refused`);
    }
  }],

  ["ec2 adapter: status, logs, files and cancel come from S3 and the instance", async () => {
    const aws = makeFakeAws({ instance: { state: "pending" } });
    let clock = Date.parse("2026-01-01T00:01:00Z");
    const adapter = createEc2ExecutionAdapter({ ec2: aws.ec2, s3: aws.s3, config: { bucket: "b", launchTemplateId: "lt", subnetIds: ["s"] }, now: () => clock });
    const ref = { provider: "ec2", jobId: "job-9", executionId: "job-9", s3Prefix: "jobs/job-9", instanceId: "i-abc", maxRuntimeSeconds: 600, submittedAt: "2026-01-01T00:00:00Z", launchedAt: "2026-01-01T00:00:00Z" };

    assert((await adapter.getStatus(ref)).state === "running", "a pending instance counts as running (EC2 jobs are running from submit)");
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
    const ref = { provider: "ec2", jobId: "job-9", s3Prefix: "jobs/job-9", instanceId: "i-abc" };
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
    const classId = await scalar(
      "INSERT INTO classes (name, term, block, teacher_id) VALUES ('Second Period Robotics', '2026-27', 'R2', $1) RETURNING id",
      [teacherId],
    );
    await pool.query("INSERT INTO class_members (class_id, user_id) VALUES ($1, $2)", [classId, studentId]);

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

// Found by the test review (2026-11-07): money, access and stored results.
tests.push(
  ["ec2 jobs: cancelling a launched job bills launch to cancel and refunds the rest once", async () => {
    const jobs = createJobsPostgresRepository({ pool });
    const { userId, balance } = await topUp("student_k1", 1000);
    const start = await balance();
    const aws = makeFakeAws({ instance: { state: "running" } });
    let clock = Date.parse("2026-01-01T00:10:00Z");
    const adapter = createEc2ExecutionAdapter({ ec2: aws.ec2, s3: aws.s3, config: { bucket: "b", launchTemplateId: "lt", subnetIds: ["s"] }, now: () => clock });
    const sync = createJobSync({ jobsRepository: jobs, getExecutionStatus: (ref) => adapter.getStatus(ref), getExecutionOutputFiles: async () => [], now: () => clock });

    const job = await jobs.createWithReservation({
      ownerUserId: userId, name: "cancel-launched", repo: "x/y", executionProvider: "ec2",
      computeType: "t4g.medium", hourlyRateCents: 360, maxRuntimeSeconds: 1800, reserveCents: 200,
    });
    const ref = { provider: "ec2", jobId: job.id, executionId: job.id, s3Prefix: `jobs/${job.id}`, instanceId: "i-abc", maxRuntimeSeconds: 1800, submittedAt: "2026-01-01T00:00:00Z", launchedAt: "2026-01-01T00:00:00Z" };
    await jobs.setExecutionRef(job.id, ref);

    // Cancelled 10 minutes after launch: 600 s at 360 c/h = 60 c; 140 c back.
    await adapter.cancel(ref);
    aws.setInstance({ state: "shutting-down" });
    const { job: settled } = await sync.synchronizeJobFromExecution(await jobs.findById(job.id));
    assert(settled.status === "failed" && settled.resultSyncKey === "cancelled" && settled.costCents === 60, `settled ${settled.status} ${settled.resultSyncKey} ${settled.costCents}`);
    assert((await balance()) === start - 60, `balance moved ${start - (await balance())}`);

    // Looked at again, long after the time limit: nothing changes.
    clock = Date.parse("2026-01-01T05:00:00Z");
    aws.setInstance(null);
    const { job: later } = await sync.synchronizeJobFromExecution(await jobs.findById(job.id));
    assert(later.resultSyncKey === "cancelled" && later.costCents === 60, `later ${later.resultSyncKey} ${later.costCents}`);
    assert((await ledgerCount(job.id, "refund")) === 1 && (await ledgerCount(job.id, "charge")) === 1, "one charge, one refund");
    assert((await balance()) === start - 60, "balance unchanged by later looks");
  }],

  ["jobSync: a finished EC2 job keeps its result when its time limit later passes; its own reported result still replaces a guess", async () => {
    const jobs = createJobsPostgresRepository({ pool });
    const { userId, balance } = await topUp("student_k2", 1000);
    const start = await balance();
    const aws = makeFakeAws({ instance: { state: "terminated" } });
    let clock = Date.parse("2026-01-01T00:10:00Z");
    const adapter = createEc2ExecutionAdapter({ ec2: aws.ec2, s3: aws.s3, config: { bucket: "b", launchTemplateId: "lt", subnetIds: ["s"] }, now: () => clock });
    const sync = createJobSync({ jobsRepository: jobs, getExecutionStatus: (ref) => adapter.getStatus(ref), getExecutionOutputFiles: async () => [], now: () => clock });

    const job = await jobs.createWithReservation({
      ownerUserId: userId, name: "ended-early", repo: "x/y", executionProvider: "ec2",
      computeType: "t4g.medium", hourlyRateCents: 360, maxRuntimeSeconds: 1800, reserveCents: 200,
    });
    const ref = { provider: "ec2", jobId: job.id, executionId: job.id, s3Prefix: `jobs/${job.id}`, instanceId: "i-abc", maxRuntimeSeconds: 1800, submittedAt: "2026-01-01T00:00:00Z", launchedAt: "2026-01-01T00:00:00Z" };
    await jobs.setExecutionRef(job.id, ref);

    // The instance is gone with no result 10 minutes in.
    const { job: ended } = await sync.synchronizeJobFromExecution(await jobs.findById(job.id));
    assert(ended.resultSyncKey === "ended:i-abc" && ended.costCents === 60, `ended ${ended.resultSyncKey} ${ended.costCents}`);
    const result = async () => (await pool.query("SELECT error, duration_seconds, finalized_at FROM results WHERE job_id = $1", [job.id])).rows[0];
    const stored = await result();

    // Hours later the adapter reports "overrun": the stored result stays.
    clock = Date.parse("2026-01-01T05:00:00Z");
    assert((await adapter.getStatus(ref)).syncKey === "overrun", "adapter now infers an overrun");
    const { job: later } = await sync.synchronizeJobFromExecution(await jobs.findById(job.id));
    assert(later.resultSyncKey === "ended:i-abc", `relabelled to ${later.resultSyncKey}`);
    assert(JSON.stringify(await result()) === JSON.stringify(stored), `result changed: ${JSON.stringify(await result())}`);

    // The job's own status.json (uploaded late) is authoritative and replaces the guess; money is settled once.
    aws.objects.set(`jobs/${job.id}/status.json`, JSON.stringify({ state: "succeeded", exit_code: 0, updated_at: "2026-01-01T00:09:30Z" }));
    const { job: reported } = await sync.synchronizeJobFromExecution(await jobs.findById(job.id));
    assert(reported.status === "completed" && reported.resultSyncKey === "status:2026-01-01T00:09:30Z", `reported ${reported.status} ${reported.resultSyncKey}`);
    assert(reported.costCents === 60 && (await balance()) === start - 60, "cost settled once");
    assert((await ledgerCount(job.id, "refund")) === 1, "one refund");
  }],

  ["ec2 jobs: parallel submits against a budget that covers one reservation: exactly one is accepted", async () => {
    const jobs = createJobsPostgresRepository({ pool });
    const userId = await scalar("INSERT INTO users (username, display_name) VALUES ('parallel.budget@lcps.org', 'Parallel Budget') RETURNING id");
    await pool.query("INSERT INTO user_roles (user_id, role) VALUES ($1, 'student')", [userId]);
    const { balance } = await topUp("parallel.budget@lcps.org", 300);
    const reserve = () => jobs.createWithReservation({
      ownerUserId: userId, name: "parallel", repo: "x/y", executionProvider: "ec2",
      computeType: "t4g.medium", hourlyRateCents: 360, maxRuntimeSeconds: 1800, reserveCents: 200,
    });
    const results = await Promise.allSettled([reserve(), reserve(), reserve()]);
    const accepted = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    assert(accepted.length === 1 && refused.length === 2, `results ${results.map((r) => r.status)}`);
    assert(refused.every((r) => r.reason instanceof BudgetError), `refusals ${refused.map((r) => r.reason)}`);
    assert((await balance()) === 100, `balance ${await balance()}`);
    await jobs.finalize(accepted[0].value.id, { syncKey: "test-done", status: "failed", neverRan: true, error: "test cleanup" });
  }],

  ["repo tree: a private repo's cached listing never reaches another user, even while GitHub is failing", async () => {
    const realFetch = globalThis.fetch;
    let githubDown = false;
    const repos = {
      "acme/secret": { private: true, item: "plans.txt", message: "secret plans" },
      "acme/open": { private: false, item: "README.md", message: "hello" },
    };
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      if (u.host !== "api.github.com") return realFetch(url, init);
      const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
      if (githubDown) return reply(403, { message: "API rate limit exceeded" });
      const match = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(u.pathname);
      const info = match && repos[match[1]];
      const auth = init.headers?.Authorization || "";
      if (!info || (info.private && auth !== "Bearer ghu_owner")) return reply(404, { message: "Not Found" });
      const rest = match[2] || "";
      const commit = { sha: "abc123", commit: { message: info.message, author: { date: "2026-11-01T00:00:00Z" } } };
      if (!rest) return reply(200, { private: info.private, default_branch: "main" });
      if (rest === "/commits/main") return reply(200, commit);
      if (rest === "/commits") return reply(200, [commit]);
      if (rest === "/contents") return reply(200, [{ name: info.item, path: info.item, type: "file", size: 5 }]);
      return reply(404, { message: "Not Found" });
    };
    const githubApp = () => ({
      async getUserAccessToken(userId) { return userId === "owner" ? "ghu_owner" : null; },
      async forgetRevokedLink() {},
    });
    const app = express();
    app.use((req, _res, next) => { req.user = { id: req.get("x-test-user") }; next(); });
    app.use("/api/repos", createRepoRouter({ githubApp }));
    const served = await serveApp(app);
    const tree = async (user, repo) => (await realFetch(`${served.baseUrl}/api/repos/${repo}/tree`, { headers: { "x-test-user": user } })).json();
    try {
      const own = await tree("owner", "acme/secret");
      assert(own.items?.[0]?.name === "plans.txt" && !own.stale, `owner listing ${JSON.stringify(own)}`);
      await tree("owner", "acme/open");

      githubDown = true;
      const other = await tree("someone-else", "acme/secret");
      assert(other.stale === true && other.items.length === 0, `another user saw ${JSON.stringify(other.items)}`);
      assert(!JSON.stringify(other).includes("secret plans"), "commit message leaked");
      const ownAgain = await tree("owner", "acme/secret");
      assert(ownAgain.stale === true && ownAgain.items[0]?.name === "plans.txt", "the owner still gets the cached listing");
      const open = await tree("someone-else", "acme/open");
      assert(open.stale === true && open.items[0]?.name === "README.md", "a public repo's listing may be shared");

      // ".." and other all-dot names are refused before any GitHub call (sent
      // raw: fetch would resolve the dots itself).
      for (const rawPath of ["/api/repos/%2E%2E/user/tree", "/api/repos/acme/../tree", "/api/repos/acme/.../branches"]) {
        const { hostname, port } = new URL(served.baseUrl);
        const status = await new Promise((resolve, reject) => {
          const request = http.request({ hostname, port, path: rawPath, headers: { "x-test-user": "owner" } }, (response) => { response.resume(); resolve(response.statusCode); });
          request.on("error", reject);
          request.end();
        });
        assert(status === 400, `${rawPath}: expected 400, got ${status}`);
      }
    } finally {
      globalThis.fetch = realFetch;
      await served.close();
    }
  }],

  ["connections: the OAuth callback state must match, be fresh, be for this provider, and works once", async () => {
    let completed = 0;
    const fakeProvider = (id) => ({
      id,
      label: id,
      async status() { return { configured: true }; },
      async authorizeUrl(state) { return `https://provider.example/authorize?state=${state}`; },
      async completeCallback() { completed += 1; return "connected"; },
      async getLink() { return null; },
      async unlink() {},
      async listItems() { return []; },
    });
    const app = express();
    app.use(session({ secret: "test-secret", resave: false, saveUninitialized: false }));
    app.use((req, _res, next) => { req.user = { id: "u-1" }; next(); });
    app.use("/api/connections/alpha", createProviderRouter(fakeProvider("alpha")));
    app.use("/api/connections/beta", createProviderRouter(fakeProvider("beta")));
    const served = await serveApp(app);
    const jar = createCookieJar();
    const connect = async (provider) => {
      const response = await jar.fetch(`${served.baseUrl}/api/connections/${provider}/connect`, { redirect: "manual" });
      return new URL(response.headers.get("location")).searchParams.get("state");
    };
    const callback = async (provider, query) => {
      const response = await jar.fetch(`${served.baseUrl}/api/connections/${provider}/callback?${new URLSearchParams(query)}`, { redirect: "manual" });
      return new URL(response.headers.get("location"), served.baseUrl).searchParams.get("result");
    };
    const realNow = Date.now;
    try {
      // Wrong value of the right length; the real state is then used up.
      let state = await connect("alpha");
      const wrong = (state[0] === "A" ? "B" : "A") + state.slice(1);
      assert((await callback("alpha", { code: "c", state: wrong })) === "state", "wrong state");
      assert((await callback("alpha", { code: "c", state })) === "state", "a state is used up by a failed try");

      // Right state works once.
      state = await connect("alpha");
      assert((await callback("alpha", { code: "c", state })) === "connected", "right state");
      assert((await callback("alpha", { code: "c", state })) === "state", "replayed state");

      // Another provider's state.
      state = await connect("beta");
      assert((await callback("alpha", { code: "c", state })) === "state", "beta's state at alpha");

      // Older than 10 minutes.
      state = await connect("alpha");
      Date.now = () => realNow() + 11 * 60 * 1000;
      assert((await callback("alpha", { code: "c", state })) === "state", "expired state");
      Date.now = realNow;

      // The user said no at the provider.
      state = await connect("alpha");
      assert((await callback("alpha", { state, error: "access_denied" })) === "denied", "denied");
      assert(completed === 1, `completeCallback ran ${completed} times, expected only for the one good callback`);
    } finally {
      Date.now = realNow;
      await served.close();
    }
  }],

  ["connections: a linked account's tokens never appear in connection responses", async () => {
    const userId = await scalar("SELECT id FROM users WHERE username = 'student_g3'");
    const store = driveStore();
    await store.saveLink(userId, { externalId: "g-sentinel", login: "c1@example.com", clientId: "client-1", tokens: { accessToken: "ya29.SENTINEL", refreshToken: "1//SENTINEL", scope: driveScope, accessExpiresAt: new Date(Date.now() + 3600e3) } });
    await store.addPicked(userId, [{ id: "rootFolder01", label: "ML Club", kind: "folder" }]);
    const drive = createGoogleDriveProvider({ store, settings: fakeGoogleSettings(), fetch: makeFakeDrive(sampleDriveTree()).fetch });
    const app = express();
    app.use((req, _res, next) => { req.user = { id: userId }; next(); });
    app.use("/api/connections/google_drive", createProviderRouter(drive));
    const served = await serveApp(app);
    try {
      const described = await describeProvider(drive, userId);
      assert(described.linked === true && !JSON.stringify(described).includes("SENTINEL"), `describe ${JSON.stringify(described)}`);
      for (const path of ["", "/items"]) {
        const response = await fetch(`${served.baseUrl}/api/connections/google_drive${path}`);
        const body = await response.text();
        assert(response.ok && !body.includes("SENTINEL"), `${path || "/"}: ${response.status} ${body}`);
      }
    } finally {
      await served.close();
      await store.deleteLink(userId);
    }
  }],

  ["google drive: one user cannot browse, use or remove another user's picked item", async () => {
    const owner = await scalar("SELECT id FROM users WHERE username = 'student_k4'");
    const other = await scalar("SELECT id FROM users WHERE username = 'student_k5'");
    const store = driveStore();
    const link = (externalId) => ({ externalId, login: `${externalId}@example.com`, clientId: "client-1", tokens: { accessToken: `ya29.${externalId}`, scope: driveScope, accessExpiresAt: new Date(Date.now() + 3600e3) } });
    await store.saveLink(owner, link("g-owner"));
    await store.saveLink(other, link("g-other"));
    await store.addPicked(owner, [{ id: "rootFolder01", label: "ML Club", kind: "folder" }]);
    const drive = createGoogleDriveProvider({ store, settings: fakeGoogleSettings(), fetch: makeFakeDrive(sampleDriveTree()).fetch });
    const source = createDriveSource({ provider: drive });
    try {
      assert((await drive.browse(owner, "rootFolder01", "")).items.length > 0, "the owner can browse");
      const status = async (fn) => { try { await fn(); return 200; } catch (error) { return error.status; } };
      assert((await status(() => drive.browse(other, "rootFolder01", ""))) === 403, "another user browsing");
      assert((await status(() => source.resolveAccess(other, { itemId: "rootFolder01", path: "" }))) === 403, "another user submitting a job from it");
      assert((await drive.removePickedItem(other, "rootFolder01")) === false, "another user removing it");
      assert((await drive.listItems(owner)).some((item) => item.id === "rootFolder01"), "the owner's pick remains");
    } finally {
      await store.deleteLink(owner);
      await store.deleteLink(other);
    }
  }],
);

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

httpTests.push(
  ["ec2 cancel route: a job still being prepared is refunded in full once; a finished job cannot be cancelled", async () => {
    const jobs = createJobsPostgresRepository({ pool });
    const { userId, balance } = await topUp("student_k3", 500);
    const start = await balance();
    const job = await jobs.createWithReservation({
      ownerUserId: userId, name: "route-cancel", repo: "x/y", executionProvider: "ec2",
      computeType: "t4g.medium", hourlyRateCents: 360, maxRuntimeSeconds: 1800, reserveCents: 200,
    });
    assert((await balance()) === start - 200, "reserved");

    const jar = createCookieJar();
    await login(jar, server.baseUrl, "student_k3", "student123");
    const cancel = await jar.fetch(`${server.baseUrl}/api/jobs/${job.id}/cancel`, { method: "POST" });
    assert(cancel.ok, `cancel ${cancel.status}`);
    assert((await balance()) === start && (await ledgerCount(job.id, "refund")) === 1, `refund: balance moved ${start - (await balance())}`);

    const again = await jar.fetch(`${server.baseUrl}/api/jobs/${job.id}/cancel`, { method: "POST" });
    assert(again.status === 409, `second cancel: expected 409, got ${again.status}`);

    // A finished, launched job: refused before any cancel marker is written.
    const launched = await jobs.createWithReservation({
      ownerUserId: userId, name: "route-cancel-finished", repo: "x/y", executionProvider: "ec2",
      computeType: "t4g.medium", hourlyRateCents: 360, maxRuntimeSeconds: 1800, reserveCents: 200,
    });
    await jobs.setExecutionRef(launched.id, { provider: "ec2", jobId: launched.id, executionId: launched.id, s3Prefix: `jobs/${launched.id}`, instanceId: "i-done", launchedAt: "2026-01-01T00:00:00Z" });
    await jobs.finalize(launched.id, { syncKey: "status:done", status: "completed", durationSeconds: 600 });
    const finished = await jar.fetch(`${server.baseUrl}/api/jobs/${launched.id}/cancel`, { method: "POST" });
    assert(finished.status === 409, `finished cancel: expected 409, got ${finished.status}`);
    assert((await jobs.findById(launched.id)).resultSyncKey === "status:done", "result unchanged");
    assert((await ledgerCount(job.id, "refund")) === 1, "still one refund");
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
