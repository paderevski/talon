import assert from "node:assert/strict";
import test from "node:test";
import { formatRuntime, planJob } from "../src/utils/jobPlan.js";

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

test("unknown time limit gives no estimate and never blocks", () => {
  const plan = planJob({ compute: compute(), runOn: "c7g.large", maxRuntimeSeconds: 999, budgetDollars: 0 });
  assert.equal(plan.estimateCents, null);
  assert.equal(plan.estimateDollars, null);
  assert.equal(plan.overBudget, false);
});

test("over budget only when the reserve is more than the remaining budget", () => {
  const over = (budgetDollars) => planJob({ compute: compute(), runOn: "m7g.large", maxRuntimeSeconds: 3600, budgetDollars }).overBudget;
  assert.equal(over(0.11), true);
  assert.equal(over(0.12), false, "exactly enough is allowed");
  assert.equal(over(0.13), false);
  assert.equal(over(0), true);
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
