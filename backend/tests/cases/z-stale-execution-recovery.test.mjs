import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { assert, backendRoot, startBackendForTests } from "../lib/harness.mjs";

export const name = "stale execution references recover to failed";

export async function run() {
  const jobsFilePath = path.resolve(backendRoot, "src", "data", "jobs.json");
  const resultsFilePath = path.resolve(
    backendRoot,
    "src",
    "data",
    "results.json",
  );

  const jobsBackup = await readFile(jobsFilePath, "utf8");
  const resultsBackup = await readFile(resultsFilePath, "utf8");

  const staleJobId = `job-stale-${Date.now()}`;
  const staleExecutionId = `local-stale-${Date.now()}`;

  let isolatedBackend = null;

  try {
    const jobsPayload = JSON.parse(jobsBackup);
    const nextJobs = Array.isArray(jobsPayload?.items) ? jobsPayload.items : [];

    nextJobs.unshift({
      id: staleJobId,
      name: "stale-execution-job",
      repo: "paderevski/minimal-rnn",
      status: "running",
      gpu: "—",
      submitted: "just now",
      duration: "—",
      executionProvider: "local",
      executionRef: {
        provider: "local",
        executionId: staleExecutionId,
        submittedAt: new Date().toISOString(),
      },
    });

    await writeFile(
      jobsFilePath,
      `${JSON.stringify({ items: nextJobs, updatedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );

    isolatedBackend = await startBackendForTests();

    const jobsResponse = await fetch(
      `${isolatedBackend.baseUrl}/api/jobs?status=all`,
    );
    assert(
      jobsResponse.ok,
      `Expected jobs endpoint to return 200, got ${jobsResponse.status}`,
    );
    const jobsBody = await jobsResponse.json();
    const staleJob = (jobsBody.items || []).find(
      (job) => job.id === staleJobId,
    );

    assert(staleJob, "Expected stale job to be present in response");
    assert(
      staleJob.status === "failed",
      `Expected stale job to become failed, got ${staleJob.status}`,
    );
    assert(
      String(staleJob.resultSyncKey || "").startsWith("lost:"),
      "Expected stale job to include lost:* resultSyncKey",
    );

    const resultsResponse = await fetch(
      `${isolatedBackend.baseUrl}/api/results`,
    );
    assert(
      resultsResponse.ok,
      `Expected results endpoint to return 200, got ${resultsResponse.status}`,
    );
    const resultsBody = await resultsResponse.json();
    const persistedResult = (resultsBody.items || []).find(
      (result) => result.jobId === staleJobId,
    );

    assert(persistedResult, "Expected failed result entry for stale job");
    assert(
      persistedResult.status === "failed",
      "Expected stale job result status to be failed",
    );
  } finally {
    if (isolatedBackend) {
      await isolatedBackend.stop();
    }

    await writeFile(jobsFilePath, jobsBackup, "utf8");
    await writeFile(resultsFilePath, resultsBackup, "utf8");
  }
}
