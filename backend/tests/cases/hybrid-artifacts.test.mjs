import { writeFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  assert,
  backendRoot,
  waitFor,
  waitForJobTerminalState,
} from "../lib/harness.mjs";

export const name = "hybrid artifacts include output_dir and repo_changed";

async function waitForDirectory(directoryPath, label) {
  await waitFor(
    async () => {
      try {
        const details = await stat(directoryPath);
        return details.isDirectory();
      } catch {
        return false;
      }
    },
    { timeoutMs: 45_000, intervalMs: 250, label },
  );
}

export async function run({ baseUrl }) {
  const submitResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "hybrid-regression",
      repo: "paderevski/minimal-rnn",
      branch: "main",
      entryScript: "script.py",
    }),
  });

  assert(
    submitResponse.ok,
    `Expected submit job to succeed, got ${submitResponse.status}`,
  );
  const submitPayload = await submitResponse.json();

  const jobId = submitPayload?.job?.id;
  const executionId = submitPayload?.job?.executionRef?.executionId;

  assert(
    typeof jobId === "string" && jobId.length > 0,
    "Missing job id in submit response",
  );
  assert(
    typeof executionId === "string" && executionId.length > 0,
    "Missing execution id in submit response",
  );

  const runRoot = path.resolve(backendRoot, "data", "runs", executionId);
  const outputDir = path.resolve(runRoot, "output");
  const repoDir = path.resolve(runRoot, "repo");

  await waitForDirectory(outputDir, "output dir creation");
  await waitForDirectory(repoDir, "repo dir creation");

  await writeFile(
    path.resolve(outputDir, "test-output-artifact.txt"),
    "artifact from output dir\n",
    "utf8",
  );

  await writeFile(
    path.resolve(repoDir, "test-repo-artifact.txt"),
    "artifact from repo changed\n",
    "utf8",
  );

  await waitForJobTerminalState(baseUrl, jobId, { timeoutMs: 120_000 });

  const filesResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/files`);
  assert(
    filesResponse.ok,
    `Expected files endpoint to return 200, got ${filesResponse.status}`,
  );

  const filesPayload = await filesResponse.json();
  const items = Array.isArray(filesPayload?.items) ? filesPayload.items : [];
  const sources = new Set(items.map((item) => item?.source).filter(Boolean));

  assert(
    sources.has("output_dir"),
    "Expected at least one output_dir artifact source",
  );
  assert(
    sources.has("repo_changed"),
    "Expected at least one repo_changed artifact source",
  );

  const outputMarker = items.find(
    (item) => item.name === "test-output-artifact.txt",
  );
  const repoMarker = items.find(
    (item) => item.name === "test-repo-artifact.txt",
  );

  assert(
    outputMarker?.source === "output_dir",
    "Expected output marker source to be output_dir",
  );
  assert(
    repoMarker?.source === "repo_changed",
    "Expected repo marker source to be repo_changed",
  );
}
