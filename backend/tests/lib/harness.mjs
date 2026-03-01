import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
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
      const response = await fetch(`${baseUrl}/api/jobs/${jobId}`);
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

export async function startBackendForTests() {
  const port = pickPort();
  const baseUrl = `http://localhost:${port}`;

  const child = spawn("node", ["src/server.js"], {
    cwd: backendRoot,
    env: {
      ...process.env,
      PORT: String(port),
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
