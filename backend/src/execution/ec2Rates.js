// Instance types jobs may use and what they cost. On-demand us-east-1 list
// prices in cents per hour (static for now; the Pricing API can replace this).
// Keep in step with allowed_job_instance_types in infra/ec2/jobs.tf, which is
// what actually limits what the web server may launch.
const instanceTypes = {
  "t4g.small": { label: "2 vCPU, 2 GB (t4g.small)", cents: 1.68 },
  "t4g.medium": { label: "2 vCPU, 4 GB (t4g.medium)", cents: 3.36 },
  "t4g.large": { label: "2 vCPU, 8 GB (t4g.large)", cents: 6.72 },
};

export const defaultInstanceType = "t4g.medium";

// Costs not in the per-second instance rate: the public IPv4 address (about
// 0.5 cents/h) and the root volume (about 0.3 cents/h).
function overheadCentsPerHour() {
  const value = Number(process.env.JOB_RATE_OVERHEAD_CENTS_PER_HOUR);
  return Number.isFinite(value) && value >= 0 ? value : 1;
}

// Time billed before and after the user's script: boot, setup, upload,
// shutdown. Added to the time limit when reserving.
export function bootAllowanceSeconds() {
  const value = Number(process.env.JOB_BOOT_ALLOWANCE_SECONDS);
  return Number.isFinite(value) && value >= 0 ? value : 300;
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

export function listInstanceOptions() {
  return Object.keys(instanceTypes).map((instanceType) => ({
    instanceType,
    label: instanceTypes[instanceType].label,
    hourlyRateCents: hourlyRateCentsFor(instanceType),
  }));
}
