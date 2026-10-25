import { spawn } from "node:child_process";
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
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
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
    `INSERT INTO jobs (owner_user_id, name, repo, status, execution_provider, execution_ref, duration_seconds)
     SELECT id, $2, 'paderevski/minimal-rnn', $3, 'local', $4::jsonb, $5 FROM users WHERE username = $1
     RETURNING id`,
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

function pickPort() {
  const min = 5500;
  const max = 6500;
  return Math.floor(Math.random() * (max - min + 1)) + min;
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
