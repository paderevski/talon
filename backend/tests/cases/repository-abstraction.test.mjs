import { assert } from "../lib/harness.mjs";

export const name = "repository abstraction serves jobs and results";

export async function run({ baseUrl }) {
  const jobsResponse = await fetch(`${baseUrl}/api/jobs?status=all`);
  assert(
    jobsResponse.ok,
    `Expected /api/jobs to return 200, got ${jobsResponse.status}`,
  );
  const jobsPayload = await jobsResponse.json();
  assert(
    Array.isArray(jobsPayload?.items),
    "Expected /api/jobs response to contain items[]",
  );

  const resultsResponse = await fetch(`${baseUrl}/api/results`);
  assert(
    resultsResponse.ok,
    `Expected /api/results to return 200, got ${resultsResponse.status}`,
  );
  const resultsPayload = await resultsResponse.json();
  assert(
    Array.isArray(resultsPayload?.items),
    "Expected /api/results response to contain items[]",
  );
}
