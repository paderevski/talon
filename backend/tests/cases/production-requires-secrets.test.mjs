import { spawn } from "node:child_process";
import { assert, backendRoot, testDatabaseUrl } from "../lib/harness.mjs";

export const name = "production refuses to start without SESSION_SECRET and TALON_CREDENTIALS_KEY";

function runBackend(extraEnv) {
  return new Promise((resolve) => {
    const child = spawn("node", ["src/server.js"], {
      cwd: backendRoot,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: "0",
        DATABASE_URL: testDatabaseUrl,
        SESSION_SECRET: "",
        TALON_CREDENTIALS_KEY: "",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
    // If it does start, stop it shortly so the test fails instead of hanging.
    setTimeout(() => child.kill("SIGTERM"), 5_000);
  });
}

export async function run() {
  const noKeys = await runBackend({});
  assert(noKeys.code !== 0 && noKeys.code !== null, `Expected failure with no secrets, got exit ${noKeys.code}`);
  assert(/required when NODE_ENV=production/.test(noKeys.output), `Unexpected output: ${noKeys.output.slice(0, 300)}`);

  const noCredKey = await runBackend({ SESSION_SECRET: "x".repeat(64) });
  assert(noCredKey.code !== 0 && noCredKey.code !== null, "Expected failure without TALON_CREDENTIALS_KEY");
  assert(/TALON_CREDENTIALS_KEY is required/.test(noCredKey.output), `Unexpected output: ${noCredKey.output.slice(0, 300)}`);
}
