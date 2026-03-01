import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assert,
  backendRoot,
  waitFor,
  waitForJobTerminalState,
} from "../lib/harness.mjs";

export const name = "terminal jobs persist results history";

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
  const beforeResultsResponse = await fetch(`${baseUrl}/api/results`);
  assert(
    beforeResultsResponse.ok,
    "Expected initial results request to succeed",
  );
  const beforeResultsPayload = await beforeResultsResponse.json();
  const beforeCount = Array.isArray(beforeResultsPayload?.items)
    ? beforeResultsPayload.items.length
    : 0;

  const submitResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "results-persistence-regression",
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

  assert(typeof jobId === "string" && jobId.length > 0, "Missing job id");
  assert(
    typeof executionId === "string" && executionId.length > 0,
    "Missing execution id",
  );

  const runRoot = path.resolve(backendRoot, "data", "runs", executionId);
  const outputDir = path.resolve(runRoot, "output");
  const repoDir = path.resolve(runRoot, "repo");

  await waitForDirectory(outputDir, "output dir creation");
  await waitForDirectory(repoDir, "repo dir creation");

  await writeFile(
    path.resolve(outputDir, "result-persist-output-marker.txt"),
    "output marker for results persistence\n",
    "utf8",
  );
  await writeFile(
    path.resolve(repoDir, "result-persist-repo-marker.txt"),
    "repo marker for results persistence\n",
    "utf8",
  );

  await waitForJobTerminalState(baseUrl, jobId, { timeoutMs: 120_000 });

  const afterResultsResponse = await fetch(`${baseUrl}/api/results`);
  assert(afterResultsResponse.ok, "Expected results request to succeed");
  const afterResultsPayload = await afterResultsResponse.json();
  const afterItems = Array.isArray(afterResultsPayload?.items)
    ? afterResultsPayload.items
    : [];

  assert(
    afterItems.length >= beforeCount + 1,
    "Expected results list to include newly persisted runtime result",
  );

  const persisted = afterItems.find((item) => item?.jobId === jobId);
  assert(persisted, `Expected result entry for job ${jobId}`);
  assert(
    persisted.status === "completed" || persisted.status === "failed",
    `Expected persisted result to be terminal, got ${persisted.status}`,
  );

  const resultFiles = Array.isArray(persisted.files) ? persisted.files : [];
  const hasOutputMarker = resultFiles.some(
    (file) => file?.name === "result-persist-output-marker.txt",
  );
  const hasRepoMarker = resultFiles.some(
    (file) => file?.name === "result-persist-repo-marker.txt",
  );

  assert(
    hasOutputMarker,
    "Expected persisted result to include output marker file",
  );
  assert(
    hasRepoMarker,
    "Expected persisted result to include repo marker file",
  );

  const resultsFilePath = path.resolve(
    backendRoot,
    "src",
    "data",
    "results.json",
  );
  const diskPayload = JSON.parse(await readFile(resultsFilePath, "utf8"));
  const diskItems = Array.isArray(diskPayload?.items) ? diskPayload.items : [];
  const diskPersisted = diskItems.find((item) => item?.jobId === jobId);

  assert(diskPersisted, `Expected results.json to contain job ${jobId}`);
}
