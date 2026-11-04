import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assert, backendRoot, createCookieJar, login, startBackendForTests, waitFor } from "../lib/harness.mjs";

export const name = "local jobs do not see the server's secrets in their environment";

const marker = "secret-marker-should-not-leak";

export async function run() {
  // A stand-in for python3 that records the environment it was given.
  const dir = await mkdtemp(path.join(os.tmpdir(), "talon-env-"));
  const fakePython = path.join(dir, "fake-python");
  await writeFile(fakePython, '#!/bin/sh\nenv > "$TALON_OUTPUT_DIR/env.txt"\n', "utf8");
  await chmod(fakePython, 0o755);

  const backend = await startBackendForTests({
    env: {
      TALON_PYTHON_BIN: fakePython,
      SESSION_SECRET: `${marker}-${"s".repeat(40)}`,
      TALON_CREDENTIALS_KEY: `${marker}-key`,
      SOME_SERVER_SETTING: marker,
    },
    reset: false,
  });
  try {
    const jar = createCookieJar();
    await login(jar, backend.baseUrl, "admin", "admin123");
    const submit = await jar.fetch(`${backend.baseUrl}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "env-check", repo: "paderevski/minimal-rnn", branch: "main", entryScript: "script.py" }),
    });
    assert(submit.ok, `submit failed: ${submit.status}`);
    const executionId = (await submit.json())?.job?.executionRef?.executionId;
    assert(executionId, "missing execution id");

    const envFile = path.resolve(backendRoot, "data", "runs", executionId, "output", "env.txt");
    let text = "";
    await waitFor(
      async () => {
        try {
          text = await readFile(envFile, "utf8");
          return text.length > 0;
        } catch {
          return false;
        }
      },
      { timeoutMs: 60_000, intervalMs: 250, label: "job env file" },
    );

    assert(!text.includes(marker), "the job saw a server secret or setting");
    assert(!/^DATABASE_URL=/m.test(text), "the job saw DATABASE_URL");
    assert(/^AWS_EC2_METADATA_DISABLED=true$/m.test(text), "AWS SDKs in the job should not use the instance role");
    assert(/^PATH=/m.test(text), "the job should still get PATH");
    assert(/^TALON_OUTPUT_DIR=/m.test(text), "the job should get TALON_OUTPUT_DIR");
    assert(/^TALON_SCRATCH_DIR=/m.test(text), "the job should get TALON_SCRATCH_DIR");
  } finally {
    await backend.stop();
    await rm(dir, { recursive: true, force: true });
  }
}
