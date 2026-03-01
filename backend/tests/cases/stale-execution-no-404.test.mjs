import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { assert, backendRoot, startBackendForTests } from "../lib/harness.mjs";

export const name = "stale execution refs do not return 404 on read endpoints";

export async function run() {
  const jobsFilePath = path.resolve(backendRoot, "src", "data", "jobs.json");
  const jobsBackup = await readFile(jobsFilePath, "utf8");

  const staleJobId = `job-stale-read-${Date.now()}`;
  const staleExecutionId = `local-stale-read-${Date.now()}`;

  let isolatedBackend = null;

  try {
    const jobsPayload = JSON.parse(jobsBackup);
    const nextJobs = Array.isArray(jobsPayload?.items) ? jobsPayload.items : [];

    nextJobs.unshift({
      id: staleJobId,
      name: "stale-execution-read-job",
      repo: "paderevski/minimal-rnn",
      status: "completed",
      gpu: "—",
      submitted: "just now",
      duration: "12s",
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

    const detailResponse = await fetch(
      `${isolatedBackend.baseUrl}/api/jobs/${staleJobId}`,
    );
    assert(
      detailResponse.ok,
      `Expected detail endpoint 200, got ${detailResponse.status}`,
    );
    const detailBody = await detailResponse.json();
    assert(
      detailBody?.noData === true,
      "Expected detail noData=true for stale execution ref",
    );
    assert(
      detailBody?.job?.id === staleJobId,
      "Expected detail to return stored job metadata",
    );
    assert(
      detailBody?.execution === null,
      "Expected execution=null for stale execution ref",
    );

    const logsResponse = await fetch(
      `${isolatedBackend.baseUrl}/api/jobs/${staleJobId}/logs`,
    );
    assert(
      logsResponse.ok,
      `Expected logs endpoint 200, got ${logsResponse.status}`,
    );
    const logsBody = await logsResponse.json();
    assert(
      logsBody?.noData === true,
      "Expected logs noData=true for stale execution ref",
    );
    assert(
      Array.isArray(logsBody?.lines) && logsBody.lines.length === 0,
      "Expected empty logs for stale execution ref",
    );

    const filesResponse = await fetch(
      `${isolatedBackend.baseUrl}/api/jobs/${staleJobId}/files`,
    );
    assert(
      filesResponse.ok,
      `Expected files endpoint 200, got ${filesResponse.status}`,
    );
    const filesBody = await filesResponse.json();
    assert(
      filesBody?.noData === true,
      "Expected files noData=true for stale execution ref",
    );
    assert(
      Array.isArray(filesBody?.items) && filesBody.items.length === 0,
      "Expected empty files for stale execution ref",
    );
  } finally {
    if (isolatedBackend) {
      await isolatedBackend.stop();
    }

    await writeFile(jobsFilePath, jobsBackup, "utf8");
  }
}
