// What the submit form shows and allows, worked out from the server's compute
// options, the chosen machine and time limit, and the student's budget.
// Kept free of React so it can be tested (frontend/tests).
// The server checks the budget again when the job starts (402); this only
// keeps the form from offering what cannot start.

export const DEFAULT_MACHINE = "m7g.large";
const PREFERRED_RUNTIME_SECONDS = 3600;

export function formatRuntime(seconds) {
  return seconds < 3600 ? `${seconds / 60} minutes` : `${seconds / 3600} ${seconds === 3600 ? "hour" : "hours"}`;
}

// "NVIDIA T4 (16 GB GPU), 16 GB memory, 4 CPUs (g4dn.xlarge) - $0.541/hour"
export function machineLabel(option) {
  const gpu = option.gpu ? `${option.gpu} (${option.gpuMemoryGb} GB GPU), ` : "";
  return `${gpu}${option.memoryGb} GB memory, ${option.vcpus} CPUs (${option.instanceType}) - $${(option.hourlyRateCents / 100).toFixed(3)}/hour`;
}

const reserveFor = (machine, seconds) => machine?.reserveCentsByRuntime?.[seconds] ?? null;

// compute: response of GET /api/jobs/compute-options (or null before it loads).
// runOn: the chosen instance type, "local", or "" for the default.
// maxRuntimeSeconds: the chosen time limit (string or number).
// budgetDollars: the student's remaining budget, null when it does not apply.
export function planJob({ compute = null, runOn = "", maxRuntimeSeconds, budgetDollars = null }) {
  // Without EC2 the job runs on the web server itself (development, or
  // admins), and there is no machine to choose.
  const ec2 = compute?.ec2?.enabled ? compute.ec2 : null;
  const localAllowed = compute ? compute.localAllowed !== false : true;
  const hasBudget = budgetDollars !== null && budgetDollars !== undefined && Number.isFinite(Number(budgetDollars));
  const budgetCents = hasBudget ? Math.round(Number(budgetDollars) * 100) : null;
  const fits = (cents) => cents === null || budgetCents === null || cents <= budgetCents;

  // Each machine's own time limits (GPU types can have a lower ceiling), and
  // whether the budget covers each one.
  const runtimesOf = (option) => option.runtimeSeconds || ec2?.runtimeSeconds || [];
  const choicesOf = (option) =>
    runtimesOf(option).map((seconds) => {
      const reserveCents = reserveFor(option, seconds);
      return { seconds, reserveCents, affordable: fits(reserveCents) };
    });
  const machines = (ec2?.options || []).map((option) => ({
    ...option,
    kind: option.gpu ? "gpu" : "cpu",
    affordable: choicesOf(option).some((choice) => choice.affordable),
  }));

  const pickDefaultMachine = () => {
    const preferred = machines.find((m) => m.instanceType === DEFAULT_MACHINE);
    if (preferred?.affordable) return preferred.instanceType;
    return (machines.find((m) => m.affordable) || preferred || machines[0])?.instanceType;
  };
  const effectiveRunOn = runOn || (ec2 ? pickDefaultMachine() : "local");
  const selectedMachine = machines.find((option) => option.instanceType === effectiveRunOn) || null;

  // Keep the chosen time limit when it is offered and affordable; otherwise
  // the longest affordable one up to an hour, else the shortest affordable,
  // else (nothing fits) the chosen or first one, shown as over budget.
  const runtimeChoices = selectedMachine ? choicesOf(selectedMachine) : (ec2?.runtimeSeconds || []).map((seconds) => ({ seconds, reserveCents: null, affordable: true }));
  const requested = runtimeChoices.find((choice) => choice.seconds === Number(maxRuntimeSeconds));
  const affordable = runtimeChoices.filter((choice) => choice.affordable);
  const chosen =
    (requested?.affordable && requested) ||
    [...affordable].reverse().find((choice) => choice.seconds <= PREFERRED_RUNTIME_SECONDS) ||
    affordable[0] ||
    requested ||
    runtimeChoices[0] ||
    null;
  const runtimeSeconds = chosen ? chosen.seconds : Number(maxRuntimeSeconds);

  // The most the job can cost; reserved from the budget when it starts.
  const estimateCents = selectedMachine ? reserveFor(selectedMachine, runtimeSeconds) : null;
  const estimateDollars = estimateCents === null ? null : estimateCents / 100;
  const overBudget = estimateCents !== null && !fits(estimateCents);

  return {
    ec2,
    localAllowed,
    machines,
    hasGpuMachines: machines.some((m) => m.kind === "gpu"),
    runOn: effectiveRunOn,
    selectedMachine,
    runtimeChoices,
    runtimeSeconds,
    estimateCents,
    estimateDollars,
    overBudget,
    nowhereToRun: !ec2 && !localAllowed,
  };
}
