import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDemoUsers } from "../../src/db/seedDemo.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const backendRoot = path.resolve(__dirname, "../..");

export const testDatabaseUrl =
  process.env.TEST_DATABASE_URL || "postgres://localhost/talon_test";

// Drops everything in the throwaway test database, then migrates and seeds
// the demo users. Refuses any database whose name does not contain "test".
export async function resetTestDatabase(databaseUrl = testDatabaseUrl) {
  if (!/test/i.test(new URL(databaseUrl).pathname)) {
    throw new Error(`Refusing to reset non-test database ${databaseUrl}`);
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await pool.query("DROP SCHEMA IF EXISTS reporting CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
    await seedDemoUsers(pool);
  } finally {
    await pool.end();
  }
}

// Run a callback with a pg client on the test database (for setting up or
// inspecting state directly).
export async function withTestDb(fn) {
  const pool = new pg.Pool({ connectionString: testDatabaseUrl });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

// Inserts a job owned by an existing user; returns its id.
export async function insertTestJob(pool, { owner = "admin", name, status, executionId, durationSeconds = null }) {
  const result = await pool.query(
    `WITH job AS (
       INSERT INTO jobs (owner_user_id, name, source_label, status, execution_provider, execution_ref, duration_seconds)
       SELECT id, $2, 'paderevski/minimal-rnn', $3, 'local', $4::jsonb, $5 FROM users WHERE username = $1
       RETURNING id
     ), code AS (
       INSERT INTO job_inputs (job_id, role, source_type, source_ref)
       SELECT id, 'code', 'github', '{"host": "github.com", "repo": "paderevski/minimal-rnn", "branch": "main"}'::jsonb FROM job
     )
     SELECT id FROM job`,
    [
      owner,
      name,
      status,
      JSON.stringify({ provider: "local", executionId, submittedAt: new Date().toISOString() }),
      durationSeconds,
    ],
  );
  return result.rows[0].id;
}

export function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export async function waitFor(
  conditionFn,
  { timeoutMs = 30_000, intervalMs = 250, label = "condition" } = {},
) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await conditionFn()) {
        return true;
      }
    } catch {
      // Best-effort polling.
    }

    await delay(intervalMs);
  }

  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

export async function waitForJobTerminalState(
  baseUrl,
  jobId,
  { timeoutMs = 120_000 } = {},
) {
  let lastStatusPayload = null;

  await waitFor(
    async () => {
      const response = await apiFetch(`${baseUrl}/api/jobs/${jobId}`);
      assert(
        response.ok,
        `Failed to read job status for ${jobId} (${response.status})`,
      );
      const payload = await response.json();
      lastStatusPayload = payload;

      const state = payload?.execution?.state || payload?.job?.status;
      return ["completed", "failed", "cancelled"].includes(state);
    },
    { timeoutMs, intervalMs: 500, label: `job ${jobId} terminal state` },
  );

  return lastStatusPayload;
}

// Local stand-ins for the GitHub repositories the tests submit jobs from, so
// the suite never clones from github.com. Built once per test process; the
// backend's git (TALON_GIT_BIN) is a wrapper that rewrites
// https://github.com/ to this folder. Per repo: { branch: { path: text } }.
const gitFixtures = {
  "octocat/Hello-World": { master: { README: "Hello World!\n" } },
  "paderevski/minimal-rnn": {
    main: {
      // Runs long enough for tests to drop marker files in its folders.
      "script.py": 'import os, time\nprint("Counting")\ntime.sleep(2)\nopen("output.txt", "w").write("Counter: 1\\n")\nprint("Done")\n',
      "train.py": 'import time\ntime.sleep(2)\nprint("trained")\n',
      "requirements.txt": "numpy\n",
    },
  },
};

let gitWrapper = null;
export function fixtureGitBin() {
  if (gitWrapper) {
    return gitWrapper;
  }
  // Named by content, so runs reuse it and a changed fixture gets a new one.
  const digest = createHash("sha256").update(JSON.stringify(gitFixtures)).digest("hex").slice(0, 12);
  const root = path.join(os.tmpdir(), `talon-git-fixtures-${digest}`);
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Talon Tests", "-c", "user.email=tests@example.org", ...args], { cwd, stdio: "ignore" });
  for (const [repo, branches] of Object.entries(gitFixtures)) {
    const bare = path.join(root, `${repo}.git`);
    if (existsSync(bare)) {
      continue;
    }
    for (const [branch, files] of Object.entries(branches)) {
      const work = path.join(root, "work", repo, branch);
      mkdirSync(work, { recursive: true });
      git(work, "init", "-q", "-b", branch);
      for (const [name, text] of Object.entries(files)) {
        writeFileSync(path.join(work, name), text);
      }
      git(work, "add", ".");
      git(work, "commit", "-q", "-m", "fixture");
      mkdirSync(path.dirname(bare), { recursive: true });
      git(path.dirname(bare), "clone", "-q", "--bare", work, bare);
    }
  }
  gitWrapper = path.join(root, "git");
  writeFileSync(gitWrapper, `#!/bin/sh\nexec git -c protocol.file.allow=always -c "url.file://${root}/.insteadOf=https://github.com/" "$@"\n`);
  chmodSync(gitWrapper, 0o755);
  return gitWrapper;
}

// fetch() refuses the Fetch standard's "bad ports"; 6000 (X11) is the only
// one in this range, and a backend there never passes its health check.
const fetchBlockedPorts = new Set([6000]);

function pickPort() {
  const min = 5500;
  const max = 6500;
  let port;
  do {
    port = Math.floor(Math.random() * (max - min + 1)) + min;
  } while (fetchBlockedPorts.has(port));
  return port;
}

export async function startBackendForTests({ env: extraEnv = {}, reset = true } = {}) {
  const port = pickPort();
  const baseUrl = `http://127.0.0.1:${port}`;

  if (reset) {
    await resetTestDatabase();
  }

  const child = spawn("node", ["src/server.js"], {
    cwd: backendRoot,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: testDatabaseUrl,
      // Tests never talk to GitHub: the GitHub App is off unless a test asks.
      GITHUB_APP_CLIENT_ID: "",
      GITHUB_APP_SLUG: "",
      GITHUB_APP_CLIENT_SECRET: "",
      GITHUB_APP_PRIVATE_KEY: "",
      GITHUB_APP_PRIVATE_KEY_FILE: "",
      // ...and never to Google.
      GOOGLE_OAUTH_CLIENT_ID: "",
      GOOGLE_OAUTH_CLIENT_SECRET: "",
      GOOGLE_PICKER_API_KEY: "",
      GOOGLE_PROJECT_NUMBER: "",
      // ...and never clone from github.com (see gitFixtures).
      TALON_GIT_BIN: fixtureGitBin(),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let bootOutput = "";

  child.stdout?.on("data", (chunk) => {
    bootOutput += chunk.toString("utf8");
  });

  child.stderr?.on("data", (chunk) => {
    bootOutput += chunk.toString("utf8");
  });

  await waitFor(
    async () => {
      const response = await fetch(`${baseUrl}/api/health`);
      return response.ok;
    },
    { timeoutMs: 30_000, intervalMs: 250, label: "backend health" },
  ).catch((error) => {
    child.kill("SIGTERM");
    throw new Error(`${error.message}\nBackend output:\n${bootOutput}`);
  });

  return {
    port,
    baseUrl,
    // Everything the backend has written to stdout/stderr so far.
    output: () => bootOutput,
    stop: async () => {
      if (child.killed) {
        return;
      }

      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        delay(5_000),
      ]);

      if (!child.killed) {
        child.kill("SIGKILL");
      }
    },
  };
}

// Minimal cookie jar for session tests: keeps name=value pairs from
// Set-Cookie and sends them back.
export function createCookieJar() {
  const cookies = new Map();

  return {
    async fetch(url, options = {}) {
      const cookieHeader = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
      const response = await fetch(url, {
        ...options,
        headers: { ...(options.headers || {}), ...(cookieHeader ? { cookie: cookieHeader } : {}) },
      });

      for (const setCookie of response.headers.getSetCookie()) {
        const [pair] = setCookie.split(";");
        const separator = pair.indexOf("=");
        const name = pair.slice(0, separator).trim();
        const value = pair.slice(separator + 1).trim();
        if (value && !/expires=Thu, 01 Jan 1970/i.test(setCookie)) {
          cookies.set(name, value);
        } else {
          cookies.delete(name);
        }
      }

      return response;
    },
    get(name) {
      return cookies.get(name);
    },
    set(name, value) {
      cookies.set(name, value);
    },
  };
}

export async function login(jar, baseUrl, username, password) {
  return jar.fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

// fetch() signed in as the seeded admin, one session per backend origin.
// Most regression tests exercise job/result behavior, not authorization.
const adminJars = new Map();

// After something ended the admin's sessions (a production server disables
// demo accounts and deletes their sessions at startup).
export function forgetAdminSessions() {
  adminJars.clear();
}

export async function apiFetch(url, options) {
  const origin = new URL(url).origin;
  let jar = adminJars.get(origin);

  if (!jar) {
    jar = createCookieJar();
    const response = await login(jar, origin, "admin", "admin123");
    if (!response.ok) {
      throw new Error(`Test admin login failed on ${origin} (${response.status})`);
    }
    adminJars.set(origin, jar);
  }

  return jar.fetch(url, options);
}
