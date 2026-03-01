import { assert } from "../lib/harness.mjs";

export const name =
  "hidden jobs are excluded by default but retained for audit";

export async function run({ baseUrl }) {
  const createResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-auth-user": "test-user",
    },
    body: JSON.stringify({
      name: `hide-me-${Date.now()}`,
      repo: "paderevski/minimal-rnn",
      branch: "main",
      entryScript: "train.py",
    }),
  });

  assert(
    createResponse.ok,
    `Expected create job 201, got ${createResponse.status}`,
  );
  const createBody = await createResponse.json();
  const jobId = createBody?.job?.id;
  assert(jobId, "Expected created job id");

  const hideResponse = await fetch(`${baseUrl}/api/jobs/${jobId}`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      "x-auth-user": "test-user",
    },
    body: JSON.stringify({ reason: "cleanup test" }),
  });

  assert(hideResponse.ok, `Expected hide job 200, got ${hideResponse.status}`);
  const hideBody = await hideResponse.json();
  assert(hideBody?.job?.hidden === true, "Expected hidden=true on hidden job");
  assert(Boolean(hideBody?.job?.hiddenAt), "Expected hiddenAt metadata");
  assert(hideBody?.job?.hiddenBy === "test-user", "Expected hiddenBy metadata");

  const defaultListResponse = await fetch(`${baseUrl}/api/jobs?status=all`);
  assert(
    defaultListResponse.ok,
    `Expected default jobs list 200, got ${defaultListResponse.status}`,
  );
  const defaultListBody = await defaultListResponse.json();
  const defaultIds = new Set(
    (defaultListBody?.items || []).map((item) => item.id),
  );
  assert(
    !defaultIds.has(jobId),
    "Expected hidden job excluded from default jobs list",
  );

  const auditListResponse = await fetch(
    `${baseUrl}/api/jobs?status=all&includeHidden=true`,
  );
  assert(
    auditListResponse.ok,
    `Expected includeHidden jobs list 200, got ${auditListResponse.status}`,
  );
  const auditListBody = await auditListResponse.json();
  const hiddenJob = (auditListBody?.items || []).find(
    (item) => item.id === jobId,
  );
  assert(hiddenJob, "Expected hidden job included when includeHidden=true");
  assert(hiddenJob.hidden === true, "Expected hidden job retained for audit");
}
