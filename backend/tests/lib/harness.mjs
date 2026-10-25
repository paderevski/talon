import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const backendRoot = path.resolve(__dirname, "../..");

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

export async function startBackendForTests({ env: extraEnv = {} } = {}) {
  const port = pickPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const tempDir = path.resolve(backendRoot, "tests/.tmp");
  const databasePath = path.resolve(tempDir, `talon-test-${port}.sqlite`);

  await mkdir(tempDir, { recursive: true });
  await rm(databasePath, { force: true });

  const child = spawn("node", ["src/server.js"], {
    cwd: backendRoot,
    env: {
      ...process.env,
      PORT: String(port),
      TALON_DB_PATH: databasePath,
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

      await rm(databasePath, { force: true });
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
