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
import { createGithubAccountsStore, GithubAccountInUseError } from "../../src/utils/githubAccountsStore.js";
import { createAppJwt, createGithubApp, normalizeSlug } from "../../src/services/githubApp.js";
import { describeCloneError, gitAuthEnv } from "../../src/execution/gitAuth.js";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { BudgetError, ensureAccount, grant, transfer } from "../../src/budget/ledger.js";
import { bootAllowanceSeconds, hourlyRateCentsFor, imageFor, isAllowedRuntime, listInstanceOptions, reservationCentsFor } from "../../src/execution/ec2Rates.js";
import createEc2ExecutionAdapter, { assertEntryScript, buildRunScript } from "../../src/execution/adapters/ec2ExecutionAdapter.js";
import { JobLimitError } from "../../src/repositories/postgres/jobsPostgresRepository.js";
import { launchEc2Job, parseEnvironmentVariables } from "../../src/services/ec2Jobs.js";
import { parseScriptArgs } from "../../src/utils/scriptArgs.js";
import { createEc2Reconciler } from "../../src/services/ec2Reconciler.js";
import { createJobSync } from "../../src/services/jobSync.js";

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

    const row = (await pool.query("SELECT * FROM github_accounts WHERE user_id = $1", [userId])).rows[0];
    assert(row.key_id === "k1", `key_id ${row.key_id}`);
    assert(!/example(ACCESS|REFRESH)/.test(Buffer.from(row.ciphertext).toString("utf8")), "ciphertext contains a token");

    const tempId = await scalar("INSERT INTO users (username, display_name) VALUES ('cascade.test@lcps.org', 'Cascade Test') RETURNING id");
    await store.saveLink(tempId, { githubUserId: 1002, githubLogin: "cascade", tokens: { accessToken: "ghu_cascade" } });
    await pool.query("DELETE FROM users WHERE id = $1", [tempId]);
    assert((await scalar("SELECT count(*) FROM github_accounts WHERE user_id = $1", [tempId])) === "0", "link should be deleted with the user");
  }],

  ["github accounts: a row copied to another user does not decrypt; one GitHub account per Talon user", async () => {
    const store = createGithubAccountsStore({ pool });
    const jane = await scalar("SELECT id FROM users WHERE username = 'jane_smith'");
    const other = await scalar("SELECT id FROM users WHERE username = 'student_a1'");
    await pool.query(
      `INSERT INTO github_accounts (user_id, github_user_id, github_login, key_id, iv, auth_tag, ciphertext)
       SELECT $2, 999999, github_login, key_id, iv, auth_tag, ciphertext FROM github_accounts WHERE user_id = $1`,
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
      assert(/Rotated 1 GitHub token set\(s\) to key id 'new2'; 0 failed/.test(output), `rotation output: ${output}`);

      process.env.TALON_CREDENTIALS_OLD_KEYS = "";
      const after = await store.getTokens(userId);
      assert(after?.accessToken === tokens.accessToken && after.refreshToken === tokens.refreshToken, "tokens unreadable after rotation");
      assert((await scalar("SELECT key_id FROM github_accounts WHERE user_id = $1", [userId])) === "new2", "key id not updated");
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
      log: { log() {}, error() {} },
    });
    await reconciler.tick();
    assert(terminated.sort().join() === "i-finished,i-orphan,i-overrun,i-untagged", `terminated ${terminated.sort()}`);
  }],

  ["ec2 reconciler: a job whose execution is gone is marked lost; other sync errors leave it alone", async () => {
    const jobs = createJobsPostgresRepository({ pool });
    const owner = await scalar("SELECT id FROM users WHERE username = 'admin'");
    const mk = (name) => jobs.createWithReservation({
      ownerUserId: owner, name, repo: "x/y", executionProvider: "ec2", hourlyRateCents: 360,
      maxRuntimeSeconds: 100, reserveCents: 5, enforceBalance: false,
    });
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
      log: { log() {}, error(message) { errors.push(message); } },
    });
    await reconciler.tick();
    assert(synced.length === 3, `a failing job must not stop the others: synced ${synced}`);
    assert(lost.length === 1 && lost[0] === gone.id, `only the 404 job is lost: ${lost}`);
    assert(errors.length === 1 && errors[0].includes(flaky.id) && errors[0].includes("AWS throttled"), `errors ${errors}`);
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
      log: { log() {}, error() {} },
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
    assert(run.InstanceType === "c7g.large" && run.ClientToken === "talon-job-7-subnet-ok", "type or client token wrong");

    let refused = "";
    try { await adapter.start({ jobId: "job-8", instanceType: "p5.48xlarge", maxRuntimeSeconds: 60 }); } catch (e) { refused = e.message; }
    assert(/not allowed/.test(refused), `unknown type: ${refused}`);
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

    await adapter.start(spec("c1", "m7g.large"));
    assert(template() === "lt-cpu", `cpu template ${template()}`);
    assert(!aws.objects.get("jobs/c1/input/run.sh").includes("/opt/pytorch"), "cpu run.sh must not use the DLAMI python");

    await adapter.start(spec("g1", "g4dn.xlarge"));
    assert(template() === "lt-gpu", `gpu template ${template()}`);
    const gpuRun = aws.objects.get("jobs/g1/input/run.sh");
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
