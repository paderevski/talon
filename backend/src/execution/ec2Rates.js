// Instance types jobs may use and what they cost. On-demand us-east-1 list
// prices in cents per hour, checked against the AWS Price List API on
// 2026-10-28 (static for now; the API can replace this). Keep the types in
// step with allowed_job_instance_types in infra/ec2/jobs.tf, which is what
// actually limits what the web server may launch.
//
// Non-burstable families only: t4g runs in unlimited-credit mode, so a job
// that keeps the CPU busy is billed surplus CPU credits on top of the
// per-second rate, which these prices would not cover.
const instanceTypes = {
  "c7g.large": { vcpus: 2, memoryGb: 4, cents: 7.25 },
  "c7g.xlarge": { vcpus: 4, memoryGb: 8, cents: 14.5 },
  "m7g.large": { vcpus: 2, memoryGb: 8, cents: 8.16 },
  "m7g.xlarge": { vcpus: 4, memoryGb: 16, cents: 16.32 },
  "r7g.large": { vcpus: 2, memoryGb: 16, cents: 10.71 },
};

export const defaultInstanceType = "m7g.large";

// Time limits students can pick (seconds). The ceiling is a setting.
const runtimeChoices = [1800, 3600, 7200, 14400, 28800, 43200, 86400];
export const defaultMaxRuntimeSeconds = 3600;

function readNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function maxRuntimeCeilingSeconds() {
  return readNumber("EC2_MAX_RUNTIME_CEILING_SECONDS", 86400) || 86400;
}

export function runtimeOptions() {
  const ceiling = maxRuntimeCeilingSeconds();
  return runtimeChoices.filter((seconds) => seconds <= ceiling);
}

export function isAllowedRuntime(seconds) {
  return runtimeOptions().includes(Number(seconds));
}

// Costs not in the per-second instance rate: the public IPv4 address (about
// 0.5 cents/h) and the root volume (about 0.3 cents/h).
function overheadCentsPerHour() {
  return readNumber("JOB_RATE_OVERHEAD_CENTS_PER_HOUR", 1);
}

// Time billed before and after the user's script: boot, setup, upload,
// shutdown. Added to the time limit when reserving.
export function bootAllowanceSeconds() {
  return readNumber("JOB_BOOT_ALLOWANCE_SECONDS", 300);
}

export function isKnownInstanceType(instanceType) {
  return Object.hasOwn(instanceTypes, instanceType);
}

// Rate charged to students for this instance type, overhead included.
export function hourlyRateCentsFor(instanceType) {
  if (!isKnownInstanceType(instanceType)) {
    throw new Error(`Unknown instance type: ${instanceType}`);
  }
  return Math.round((instanceTypes[instanceType].cents + overheadCentsPerHour()) * 10000) / 10000;
}

// The most a job can cost: the time limit plus the allowance, rounded up.
export function reservationCentsFor(hourlyRateCents, maxRuntimeSeconds) {
  return Math.max(1, Math.ceil((Number(hourlyRateCents) * (Number(maxRuntimeSeconds) + bootAllowanceSeconds())) / 3600));
}

// What the submit form offers, with the reservation for every time limit so
// the client never repeats the pricing formula.
export function listInstanceOptions() {
  return Object.keys(instanceTypes).map((instanceType) => {
    const { vcpus, memoryGb } = instanceTypes[instanceType];
    const hourlyRateCents = hourlyRateCentsFor(instanceType);
    return {
      instanceType,
      vcpus,
      memoryGb,
      hourlyRateCents,
      reserveCentsByRuntime: Object.fromEntries(
        runtimeOptions().map((seconds) => [seconds, reservationCentsFor(hourlyRateCents, seconds)]),
      ),
    };
  });
}
