import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  isCancelableJobStatus,
  jobStatusFilters,
  jobStatusValues,
  mapExecutionStateToJobStatus,
  statusLabel,
} from "../../shared/src/status.js";

test("job statuses match what the database allows", async () => {
  const sql = await readFile(new URL("../../backend/migrations/004_jobs_results.sql", import.meta.url), "utf8");
  const check = /status\s+text[^,]*CHECK \(status IN \(([^)]*)\)\)/.exec(sql);
  assert.ok(check, "jobs.status CHECK not found in 004_jobs_results.sql");
  const allowed = check[1].split(",").map((value) => value.trim().replace(/'/g, "")).sort();
  assert.deepEqual([...jobStatusValues].sort(), allowed);
});

test("the list filters are every status plus hidden and all", () => {
  assert.deepEqual([...jobStatusFilters].sort(), [...jobStatusValues, "hidden", "all"].sort());
});

test("execution states map onto job statuses; a cancel is a failure", () => {
  const expected = { running: "running", completed: "completed", failed: "failed", cancelled: "failed", queued: "queued" };
  for (const [state, status] of Object.entries(expected)) {
    assert.equal(mapExecutionStateToJobStatus(state), status, state);
  }
  assert.equal(mapExecutionStateToJobStatus(undefined), "queued");
  assert.equal(mapExecutionStateToJobStatus(""), "queued");
  for (const status of Object.values(expected)) {
    assert.ok(jobStatusValues.includes(status), `${status} is a stored status`);
  }
});

test("only unfinished jobs can be cancelled; labels", () => {
  assert.deepEqual(jobStatusValues.filter(isCancelableJobStatus).sort(), ["queued", "running"]);
  assert.equal(statusLabel("running"), "Running");
  assert.equal(statusLabel(" failed "), "Failed");
  assert.equal(statusLabel(""), "Unknown");
  assert.equal(statusLabel(null), "Unknown");
});
