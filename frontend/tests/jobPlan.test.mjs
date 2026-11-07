import assert from "node:assert/strict";
import test from "node:test";
import { formatRuntime, machineLabel, planJob } from "../src/utils/jobPlan.js";

const machine = (instanceType, reserve) => ({
  instanceType,
  memoryGb: 8,
  vcpus: 2,
  hourlyRateCents: 8,
  reserveCentsByRuntime: reserve,
});

const compute = (overrides = {}) => ({
  localAllowed: false,
  ec2: {
    enabled: true,
    runtimeSeconds: [1800, 3600],
    options: [machine("c7g.large", { 1800: 5, 3600: 9 }), machine("m7g.large", { 1800: 6, 3600: 12 })],
  },
  ...overrides,
});

test("formatRuntime", () => {
  assert.equal(formatRuntime(1800), "30 minutes");
  assert.equal(formatRuntime(3600), "1 hour");
  assert.equal(formatRuntime(7200), "2 hours");
});

test("defaults to m7g.large, else the first machine", () => {
  assert.equal(planJob({ compute: compute(), maxRuntimeSeconds: 1800 }).runOn, "m7g.large");
  const noM7g = compute();
  noM7g.ec2.options = [machine("c7g.large", { 1800: 5 })];
  assert.equal(planJob({ compute: noM7g, maxRuntimeSeconds: 1800 }).runOn, "c7g.large");
});

test("estimate comes from the chosen machine and time limit (string or number keys)", () => {
  const plan = planJob({ compute: compute(), runOn: "c7g.large", maxRuntimeSeconds: "3600" });
  assert.equal(plan.estimateCents, 9);
  assert.equal(plan.estimateDollars, 0.09);
  assert.equal(planJob({ compute: compute(), runOn: "c7g.large", maxRuntimeSeconds: 1800 }).estimateCents, 5);
});

test("a time limit the machine does not offer falls back to the default", () => {
  const plan = planJob({ compute: compute(), runOn: "c7g.large", maxRuntimeSeconds: 999 });
  assert.equal(plan.runtimeSeconds, 3600);
  assert.equal(plan.estimateCents, 9);
  assert.equal(plan.overBudget, false);
});

test("over budget only when no time limit on the machine fits the remaining budget", () => {
  const plan = (budgetDollars) => planJob({ compute: compute(), runOn: "m7g.large", maxRuntimeSeconds: 3600, budgetDollars });
  assert.equal(plan(0.12).overBudget, false, "exactly enough is allowed");
  assert.equal(plan(0.12).runtimeSeconds, 3600);
  assert.equal(plan(0.11).overBudget, false, "1 hour does not fit, 30 minutes does");
  assert.equal(plan(0.11).runtimeSeconds, 1800);
  assert.deepEqual(plan(0.11).runtimeChoices.map((c) => c.affordable), [true, false]);
  assert.equal(plan(0.05).overBudget, true, "nothing fits");
  assert.equal(plan(0).overBudget, true);
});

test("budget compares in cents, so float dollars do not misfire", () => {
  const c = compute();
  c.ec2.options = [machine("m7g.large", { 1800: 29 })];
  assert.equal(planJob({ compute: c, maxRuntimeSeconds: 1800, budgetDollars: 0.29 }).overBudget, false);
  assert.equal(planJob({ compute: c, maxRuntimeSeconds: 1800, budgetDollars: 0.1 + 0.19 }).overBudget, false);
});

test("no budget means no block (teachers, admins)", () => {
  for (const budgetDollars of [null, undefined, Number.NaN]) {
    assert.equal(planJob({ compute: compute(), maxRuntimeSeconds: 3600, budgetDollars }).overBudget, false);
  }
});

test("running on the web server is free and has no estimate", () => {
  const plan = planJob({ compute: compute({ localAllowed: true }), runOn: "local", maxRuntimeSeconds: 3600, budgetDollars: 0 });
  assert.equal(plan.selectedMachine, null);
  assert.equal(plan.estimateCents, null);
  assert.equal(plan.overBudget, false);
  assert.equal(plan.nowhereToRun, false);
});

test("nowhere to run when EC2 is off and local runs are refused", () => {
  const off = { localAllowed: false, ec2: { enabled: false, options: [] } };
  const plan = planJob({ compute: off, maxRuntimeSeconds: 1800 });
  assert.equal(plan.ec2, null);
  assert.equal(plan.nowhereToRun, true);
  assert.equal(plan.runOn, "local");
});

test("before compute options load, or in development, local is allowed", () => {
  assert.equal(planJob({ compute: null, maxRuntimeSeconds: 1800 }).nowhereToRun, false);
  const dev = planJob({ compute: { ec2: { enabled: false } }, maxRuntimeSeconds: 1800 });
  assert.equal(dev.localAllowed, true);
  assert.equal(dev.nowhereToRun, false);
});

test("a machine that is not in the menu is not selected", () => {
  const plan = planJob({ compute: compute(), runOn: "p5.48xlarge", maxRuntimeSeconds: 1800, budgetDollars: 0 });
  assert.equal(plan.selectedMachine, null);
  assert.equal(plan.overBudget, false);
});

const gpu = (instanceType, reserve, runtimeSeconds) => ({
  ...machine(instanceType, reserve),
  gpu: "NVIDIA T4",
  gpuMemoryGb: 16,
  runtimeSeconds,
});

test("each machine has its own time limits; GPU machines are marked", () => {
  const c = compute();
  c.ec2.runtimeSeconds = [1800, 3600, 7200];
  c.ec2.options.push(gpu("g6e.2xlarge", { 1800: 200, 3600: 400 }, [1800, 3600]));
  const plan = planJob({ compute: c, runOn: "g6e.2xlarge", maxRuntimeSeconds: 7200 });
  assert.deepEqual(plan.runtimeChoices.map((choice) => choice.seconds), [1800, 3600]);
  assert.equal(plan.runtimeSeconds, 3600, "7200 is over the machine's ceiling");
  assert.equal(plan.hasGpuMachines, true);
  assert.equal(plan.machines.find((m) => m.instanceType === "g6e.2xlarge").kind, "gpu");
  assert.equal(plan.machines.find((m) => m.instanceType === "c7g.large").kind, "cpu");
});

test("a machine the budget cannot cover at any time limit is marked unaffordable, and the default skips it", () => {
  const c = compute();
  c.ec2.options = [machine("m7g.large", { 1800: 60, 3600: 120 }), machine("c7g.large", { 1800: 5, 3600: 9 })];
  const plan = planJob({ compute: c, maxRuntimeSeconds: 3600, budgetDollars: 0.5 });
  assert.equal(plan.machines.find((m) => m.instanceType === "m7g.large").affordable, false);
  assert.equal(plan.runOn, "c7g.large");
  assert.equal(plan.overBudget, false);
});

test("without a budget everything is affordable (admins, teachers)", () => {
  const c = compute();
  c.ec2.options.push(gpu("g4dn.xlarge", { 1800: 30, 3600: 59 }, [1800, 3600]));
  const plan = planJob({ compute: c, runOn: "g4dn.xlarge", maxRuntimeSeconds: 3600, budgetDollars: null });
  assert.ok(plan.machines.every((m) => m.affordable));
  assert.equal(plan.runtimeSeconds, 3600);
});

test("machine labels name the GPU", () => {
  assert.equal(machineLabel(gpu("g4dn.xlarge", {}, [])), "NVIDIA T4 (16 GB GPU), 8 GB memory, 2 CPUs (g4dn.xlarge) - $0.080/hour");
  assert.equal(machineLabel(machine("c7g.large", {})), "8 GB memory, 2 CPUs (c7g.large) - $0.080/hour");
});

test("an overdrawn budget affords nothing; the default machine is still chosen and shown over budget", () => {
  const plan = planJob({ compute: compute(), maxRuntimeSeconds: 1800, budgetDollars: -0.5 });
  assert.ok(plan.machines.every((m) => !m.affordable));
  assert.equal(plan.runOn, "m7g.large");
  assert.equal(plan.overBudget, true);
});

test("a budget exactly equal to the reservation is enough", () => {
  const plan = planJob({ compute: compute(), runOn: "c7g.large", maxRuntimeSeconds: 3600, budgetDollars: 0.09 });
  assert.equal(plan.runtimeSeconds, 3600);
  assert.equal(plan.overBudget, false);
});

test("formatRuntime and machineLabel for fractional hours and GPUs", () => {
  assert.equal(formatRuntime(5400), "1.5 hours");
  assert.equal(
    machineLabel({ instanceType: "g4dn.xlarge", gpu: "NVIDIA T4", gpuMemoryGb: 16, memoryGb: 16, vcpus: 4, hourlyRateCents: 54.1 }),
    "NVIDIA T4 (16 GB GPU), 16 GB memory, 4 CPUs (g4dn.xlarge) - $0.541/hour",
  );
});
