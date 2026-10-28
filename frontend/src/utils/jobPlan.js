// What the submit form shows and allows, worked out from the server's compute
// options, the chosen machine and time limit, and the student's budget.
// Kept free of React so it can be tested (frontend/tests).

export const DEFAULT_MACHINE = "m7g.large";

export function formatRuntime(seconds) {
  return seconds < 3600 ? `${seconds / 60} minutes` : `${seconds / 3600} ${seconds === 3600 ? "hour" : "hours"}`;
}

// compute: response of GET /api/jobs/compute-options (or null before it loads).
// runOn: the chosen instance type, "local", or "" for the default.
// budgetDollars: the student's remaining budget, null when it does not apply.
export function planJob({ compute = null, runOn = "", maxRuntimeSeconds, budgetDollars = null }) {
  // Without EC2 the job runs on the web server itself (development, or
  // admins), and there is no machine to choose.
  const ec2 = compute?.ec2?.enabled ? compute.ec2 : null;
  const localAllowed = compute ? compute.localAllowed !== false : true;
  const effectiveRunOn =
    runOn || (ec2 ? ec2.options.find((o) => o.instanceType === DEFAULT_MACHINE)?.instanceType || ec2.options[0]?.instanceType : "local");
  const selectedMachine = ec2?.options.find((option) => option.instanceType === effectiveRunOn) || null;

  // The most the job can cost; reserved from the budget when it starts.
  const estimateCents = selectedMachine ? selectedMachine.reserveCentsByRuntime?.[maxRuntimeSeconds] ?? null : null;
  const estimateDollars = estimateCents === null ? null : estimateCents / 100;
  const hasBudget = budgetDollars !== null && budgetDollars !== undefined && Number.isFinite(Number(budgetDollars));
  const overBudget = estimateCents !== null && hasBudget && estimateCents > Math.round(Number(budgetDollars) * 100);

  return {
    ec2,
    localAllowed,
    runOn: effectiveRunOn,
    selectedMachine,
    estimateCents,
    estimateDollars,
    overBudget,
    nowhereToRun: !ec2 && !localAllowed,
  };
}
