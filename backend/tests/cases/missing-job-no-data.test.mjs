import { assert } from "../lib/harness.mjs";

export const name = "missing job read endpoints return no-data payloads";

export async function run({ baseUrl }) {
  const missingJobId = `job-missing-${Date.now()}`;

  const detailResponse = await fetch(`${baseUrl}/api/jobs/${missingJobId}`);
  assert(
    detailResponse.ok,
    `Expected detail endpoint 200, got ${detailResponse.status}`,
  );
  const detailBody = await detailResponse.json();
  assert(
    detailBody?.noData === true,
    "Expected detail noData=true for missing job",
  );
  assert(detailBody?.job === null, "Expected detail job=null for missing job");
  assert(
    detailBody?.execution === null,
    "Expected detail execution=null for missing job",
  );

  const logsResponse = await fetch(`${baseUrl}/api/jobs/${missingJobId}/logs`);
  assert(
    logsResponse.ok,
    `Expected logs endpoint 200, got ${logsResponse.status}`,
  );
  const logsBody = await logsResponse.json();
  assert(
    logsBody?.noData === true,
    "Expected logs noData=true for missing job",
  );
  assert(
    Array.isArray(logsBody?.lines) && logsBody.lines.length === 0,
    "Expected empty logs for missing job",
  );

  const filesResponse = await fetch(
    `${baseUrl}/api/jobs/${missingJobId}/files`,
  );
  assert(
    filesResponse.ok,
    `Expected files endpoint 200, got ${filesResponse.status}`,
  );
  const filesBody = await filesResponse.json();
  assert(
    filesBody?.noData === true,
    "Expected files noData=true for missing job",
  );
  assert(
    Array.isArray(filesBody?.items) && filesBody.items.length === 0,
    "Expected empty files for missing job",
  );
}
