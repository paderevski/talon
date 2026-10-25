import { assert, apiFetch, insertTestJob, withTestDb } from "../lib/harness.mjs";

export const name = "stale execution refs do not return 404 on read endpoints";

export async function run({ baseUrl }) {
  const staleJobId = await withTestDb((pool) =>
    insertTestJob(pool, {
      name: "stale-execution-read-job",
      status: "completed",
      executionId: `local-stale-read-${Date.now()}`,
      durationSeconds: 12,
    }),
  );

  const detailResponse = await apiFetch(`${baseUrl}/api/jobs/${staleJobId}`);
  assert(detailResponse.ok, `Expected detail endpoint 200, got ${detailResponse.status}`);
  const detailBody = await detailResponse.json();
  assert(detailBody?.noData === true, "Expected detail noData=true for stale execution ref");
  assert(detailBody?.job?.id === staleJobId, "Expected detail to return stored job metadata");
  assert(detailBody?.execution === null, "Expected execution=null for stale execution ref");

  const logsResponse = await apiFetch(`${baseUrl}/api/jobs/${staleJobId}/logs`);
  assert(logsResponse.ok, `Expected logs endpoint 200, got ${logsResponse.status}`);
  const logsBody = await logsResponse.json();
  assert(logsBody?.noData === true, "Expected logs noData=true for stale execution ref");
  assert(Array.isArray(logsBody?.lines) && logsBody.lines.length === 0, "Expected empty logs for stale execution ref");

  const filesResponse = await apiFetch(`${baseUrl}/api/jobs/${staleJobId}/files`);
  assert(filesResponse.ok, `Expected files endpoint 200, got ${filesResponse.status}`);
  const filesBody = await filesResponse.json();
  assert(filesBody?.noData === true, "Expected files noData=true for stale execution ref");
  assert(Array.isArray(filesBody?.items) && filesBody.items.length === 0, "Expected empty files for stale execution ref");
}
