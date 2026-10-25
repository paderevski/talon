import { assert, apiFetch, insertTestJob, withTestDb } from "../lib/harness.mjs";

export const name = "stale execution references recover to failed";

export async function run({ baseUrl }) {
  const staleJobId = await withTestDb((pool) =>
    insertTestJob(pool, {
      name: "stale-execution-job",
      status: "running",
      executionId: `local-stale-${Date.now()}`,
    }),
  );

  const jobsResponse = await apiFetch(`${baseUrl}/api/jobs?status=all`);
  assert(jobsResponse.ok, `Expected jobs endpoint to return 200, got ${jobsResponse.status}`);
  const jobsBody = await jobsResponse.json();
  const staleJob = (jobsBody.items || []).find((job) => job.id === staleJobId);

  assert(staleJob, "Expected stale job to be present in response");
  assert(staleJob.status === "failed", `Expected stale job to become failed, got ${staleJob.status}`);
  assert(
    String(staleJob.resultSyncKey || "").startsWith("lost:"),
    "Expected stale job to include lost:* resultSyncKey",
  );

  const resultsResponse = await apiFetch(`${baseUrl}/api/results`);
  assert(resultsResponse.ok, `Expected results endpoint to return 200, got ${resultsResponse.status}`);
  const resultsBody = await resultsResponse.json();
  const persistedResult = (resultsBody.items || []).find((result) => result.jobId === staleJobId);

  assert(persistedResult, "Expected failed result entry for stale job");
  assert(persistedResult.status === "failed", "Expected stale job result status to be failed");

  // Recovering twice must not duplicate the result.
  await apiFetch(`${baseUrl}/api/jobs?status=all`);
  const count = await withTestDb(async (pool) =>
    (await pool.query("SELECT count(*)::int AS n FROM results WHERE job_id = $1", [staleJobId])).rows[0].n,
  );
  assert(count === 1, `Expected exactly one result row, found ${count}`);
}
