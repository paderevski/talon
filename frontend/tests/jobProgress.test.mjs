import assert from "node:assert/strict";
import test from "node:test";
import { buildStages, formatElapsed, isEc2Job, parseTalonLine } from "../src/utils/jobProgress.js";

const launchedAt = "2026-11-05T14:00:00.000Z";
const job = (overrides = {}) => ({
  id: "42",
  status: "running",
  source: { type: "github", label: "octo/demo", ref: { host: "github.com", repo: "octo/demo", branch: "main", commit: "0123456789abcdef0123456789abcdef01234567" } },
  executionRef: { provider: "ec2", instanceId: "i-0abc", instanceType: "c7g.large", launchedAt, submittedAt: launchedAt },
  ...overrides,
});
const ref = Date.parse(launchedAt);
const events = (...lines) => lines.map((line) => parseTalonLine(line, ref));
const states = (result) => Object.fromEntries(result.stages.map((stage) => [stage.id, stage.state]));

const fullLog = [
  "[talon] 14:00:31 job 42 on i-0abc (c7g.large, image cpu), 9.4s after kernel boot",
  "[talon] 14:00:33 creating the job user, blocking instance metadata for it",
  "[talon] 14:00:35 downloading job input",
  "[talon] 14:00:36 unpacking the repository (12K)",
  "[talon] 14:00:36 installing Python venv and pip (apt)",
  "[talon] 14:01:02 TALON_SCRATCH_DIR=/work/scratch: root volume, 6.1G free, not saved",
  "[talon] 14:01:02 setup took 33s; running the job (limit 1800s)",
  "[talon] 14:02:10 job ended after 68s with exit code 0; saving output",
  "[talon] 14:02:12 done (succeeded); shutting down",
];

test("parseTalonLine reads step lines and ignores the student's output", () => {
  assert.deepEqual(parseTalonLine("[talon] 14:00:35 downloading job input", ref), { at: ref + 35000, text: "downloading job input" });
  assert.equal(parseTalonLine("epoch 1 loss 0.3", ref), null);
  assert.equal(parseTalonLine("[talon] TALON_SCRATCH_DIR=/work/scratch: old format", ref), null);
});

test("parseTalonLine picks the nearest day across midnight UTC", () => {
  const late = Date.parse("2026-11-05T23:59:30Z");
  assert.equal(parseTalonLine("[talon] 00:00:10 downloading job input", late).at, Date.parse("2026-11-06T00:00:10Z"));
});

test("just claimed: package and claim done, boot pending", () => {
  const result = buildStages({ job: job({ status: "queued" }) });
  assert.deepEqual(states(result), { package: "done", claim: "done", boot: "active", setup: "waiting", run: "waiting", save: "waiting", finish: "waiting" });
  assert.match(result.stages[2].detail, /Pending/);
  assert.equal(result.stages[1].detail, "c7g.large · i-0abc");
  assert.equal(result.startedAt, ref);
});

test("instance running, no boot script yet: Linux is starting", () => {
  const result = buildStages({ job: job() });
  assert.equal(states(result).boot, "active");
  assert.match(result.stages[2].detail, /Linux is starting/);
});

test("during setup: steps so far, setup active", () => {
  const result = buildStages({ job: job(), events: events(...fullLog.slice(0, 4)) });
  assert.equal(states(result).boot, "done");
  assert.equal(states(result).setup, "active");
  const setup = result.stages.find((stage) => stage.id === "setup");
  assert.deepEqual(setup.steps.map((step) => step.text), [
    "Creating the job user, blocking instance metadata for it",
    "Downloading job input",
    "Unpacking the repository (12K)",
  ]);
  assert.equal(result.stages[2].endedAt - ref, 31000);
  assert.match(result.stages[2].detail, /Linux up in 9s/);
});

test("running: last output line is the detail", () => {
  const result = buildStages({ job: job(), events: events(...fullLog.slice(0, 7)), lastOutput: "epoch 3/10 loss 0.41" });
  assert.equal(states(result).setup, "done");
  assert.equal(states(result).run, "active");
  const run = result.stages.find((stage) => stage.id === "run");
  assert.equal(run.detail, "epoch 3/10 loss 0.41");
  const setup = result.stages.find((stage) => stage.id === "setup");
  assert.equal(setup.steps.at(-1).text, "Scratch space ready: root volume, 6.1G free");
  assert.match(setup.detail, /33s/);
});

test("finished: every stage done", () => {
  const result = buildStages({ job: job({ status: "completed" }), events: events(...fullLog) });
  assert.ok(result.stages.every((stage) => stage.state === "done"));
  assert.match(result.stages.find((stage) => stage.id === "run").detail, /code 0/);
});

test("script failed: run marked failed, output still saved", () => {
  const log = [...fullLog.slice(0, 7), "[talon] 14:02:10 job ended after 68s with exit code 1; saving output", "[talon] 14:02:12 done (failed); shutting down"];
  const result = buildStages({ job: job({ status: "failed" }), events: events(...log) });
  assert.deepEqual(states(result), { package: "done", claim: "done", boot: "done", setup: "done", run: "failed", save: "done", finish: "done" });
  assert.match(result.stages.find((stage) => stage.id === "run").detail, /code 1/);
});

// A cancelled job is stored as failed with the cancel as its error (the
// database has no "cancelled" status).
test("cancelled during setup: setup stopped, later stages waiting", () => {
  const result = buildStages({ job: job({ status: "failed", error: "Job cancelled" }), events: events(...fullLog.slice(0, 3)) });
  assert.equal(states(result).setup, "failed");
  assert.equal(result.stages.find((stage) => stage.id === "setup").detail, "Job cancelled");
  assert.equal(states(result).run, "waiting");
});

test("cancelled before launch: the first step stopped with the reason", () => {
  const result = buildStages({ job: job({ status: "failed", error: "Cancelled before it started", executionRef: undefined }) });
  const failed = result.stages.filter((stage) => stage.state === "failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].id, result.stages[0].id);
  assert.equal(failed[0].detail, "Cancelled before it started");
});

test("an old completed job without step lines shows as done", () => {
  const result = buildStages({ job: job({ status: "completed" }) });
  assert.ok(result.stages.every((stage) => stage.state === "done"));
});

test("formatElapsed", () => {
  assert.equal(formatElapsed(4200), "4s");
  assert.equal(formatElapsed(68000), "1m 08s");
  assert.equal(formatElapsed(3 * 3600 * 1000 + 5 * 60 * 1000), "3h 05m");
  assert.equal(formatElapsed(-1), "");
});

test("the packaging step names the source, branch and short commit", () => {
  const result = buildStages({ job: job(), events: events(...fullLog) });
  const pkg = result.stages.find((stage) => stage.id === "package");
  assert.equal(pkg.detail, "octo/demo @ main (0123456): shallow clone, tar, upload to S3");
});

test("a Drive job's packaging step says it copies from Drive, with the file count", () => {
  const driveJob = job({ source: { type: "drive", label: "Colab Notebooks/minimal-rnn", ref: { itemId: "x", path: "minimal-rnn", fileCount: 12 } } });
  const pkg = buildStages({ job: driveJob, events: events(...fullLog) }).stages.find((stage) => stage.id === "package");
  assert.equal(pkg.title, "Copy and package the Drive folder");
  assert.equal(pkg.detail, "Colab Notebooks/minimal-rnn: 12 files from Google Drive, tar, upload to S3");
});

test("an EC2 job still being prepared shows the launcher's latest step", () => {
  const preparing = { id: "43", status: "queued", executionProvider: "ec2", source: { type: "drive", label: "Colab Notebooks/minimal-rnn", ref: {} }, launch: { progress: "Copied 200 of 584 files (12 s)", at: launchedAt } };
  assert.equal(isEc2Job(preparing), true);
  const { stages } = buildStages({ job: preparing, events: [] });
  assert.equal(stages[0].state, "active");
  assert.equal(stages[0].detail, "Copied 200 of 584 files (12 s)");
  assert.equal(stages[1].state, "waiting");
});

test("a launch that failed shows its reason on the step where it stopped", () => {
  const failed = { id: "44", status: "failed", executionProvider: "ec2", source: { type: "drive", label: "Colab Notebooks/minimal-rnn", ref: {} }, error: "Could not start the job: The code is larger than 100 MB packed (165 MB); biggest files: Niagara 01.mp4 (169 MB)" };
  const { stages } = buildStages({ job: failed, events: [] });
  assert.equal(stages[0].state, "failed");
  assert.match(stages[0].detail, /Niagara 01\.mp4 \(169 MB\)/);
});

test("an end line without an exit code says it ended, never 'undefined'", () => {
  const log = [...fullLog.slice(0, 7), "[talon] 14:02:10 job ended after 68s; saving output"];
  const result = buildStages({ job: job({ status: "running" }), events: events(...log) });
  const run = result.stages.find((stage) => stage.id === "run");
  assert.equal(run.exitCode, null);
  assert.ok(!/undefined|NaN/.test(run.detail), run.detail);
  assert.equal(run.state, "done");
});

test("exit code 124 is the time limit, and fails the run", () => {
  const log = [...fullLog.slice(0, 7), "[talon] 14:31:02 job ended after 1800s with exit code 124; saving output", "[talon] 14:31:04 done (timeout); shutting down"];
  const result = buildStages({ job: job({ status: "failed" }), events: events(...log) });
  const run = result.stages.find((stage) => stage.id === "run");
  assert.equal(run.state, "failed");
  assert.equal(run.detail, "Stopped at the time limit");
});

test("a job with no launch time yet does not throw and has no start", () => {
  const result = buildStages({ job: job({ executionRef: { provider: "ec2", instanceId: "i-1" } }), events: [] });
  assert.equal(result.startedAt, null);
});

test("log times wrap to the nearest day of the reference", () => {
  const justAfterMidnight = Date.parse("2026-11-06T00:00:05Z");
  assert.equal(new Date(parseTalonLine("[talon] 23:59:50 x", justAfterMidnight).at).toISOString(), "2026-11-05T23:59:50.000Z");
  assert.equal(new Date(parseTalonLine("[talon] 00:00:10 x", Date.parse("2026-11-05T23:59:55Z")).at).toISOString(), "2026-11-06T00:00:10.000Z");
});

test("formatElapsed edge cases", () => {
  assert.equal(formatElapsed(NaN), "");
  assert.equal(formatElapsed(-1), "");
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(59400), "59s");
});
