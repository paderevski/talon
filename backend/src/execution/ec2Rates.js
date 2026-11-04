// Instance types jobs may use and what they cost. On-demand us-east-1 list
// prices in cents per hour, checked against the AWS Price List API (CPU
// 2026-10-28, GPU 2026-11-03; static for now; the API can replace this). Keep
// the types in step with infra/ec2/jobs.tf (allowed_job_instance_types,
// gpu_job_instance_types), which is what actually limits what the web server
// may launch, and from which template.
//
// CPU: non-burstable Graviton only: t4g runs in unlimited-credit mode, so a
// job that keeps the CPU busy is billed surplus CPU credits on top of the
// per-second rate, which these prices would not cover.
//
// image: which launch template (and so which AMI) the type runs on:
//   cpu       Ubuntu 24.04 arm64, Python 3.12
//   gpu       PyTorch Deep Learning AMI, Ubuntu 24.04 x86_64, Python 3.13 with
//             torch in /opt/pytorch
// G7e (96 GB) was planned on a Base DLAMI template but had no on-demand
// capacity in us-east-1 on 2026-11-04; g6e.2xlarge (48 GB) is the big GPU.
// Optional per type: maxRuntimeSeconds (ceiling below the global one),
// bootAllowanceSeconds, extraOverheadCents (bigger root volume).
const instanceTypes = {
  "c7g.large": { vcpus: 2, memoryGb: 4, cents: 7.25 },
  "c7g.xlarge": { vcpus: 4, memoryGb: 8, cents: 14.5 },
  "m7g.large": { vcpus: 2, memoryGb: 8, cents: 8.16 },
  "m7g.xlarge": { vcpus: 4, memoryGb: 16, cents: 16.32 },
  "r7g.large": { vcpus: 2, memoryGb: 16, cents: 10.71 },
  "g4dn.xlarge": { vcpus: 4, memoryGb: 16, cents: 52.6, image: "gpu", gpu: "NVIDIA T4", gpuMemoryGb: 16, extraOverheadCents: 0.5 },
  "g4dn.2xlarge": { vcpus: 8, memoryGb: 32, cents: 75.2, image: "gpu", gpu: "NVIDIA T4", gpuMemoryGb: 16, extraOverheadCents: 0.5 },
  "g6.xlarge": { vcpus: 4, memoryGb: 16, cents: 80.48, image: "gpu", gpu: "NVIDIA L4", gpuMemoryGb: 24, extraOverheadCents: 0.5 },
  "g6e.2xlarge": {
    vcpus: 8, memoryGb: 64, cents: 224.208, image: "gpu", gpu: "NVIDIA L40S", gpuMemoryGb: 48,
    maxRuntimeSeconds: 28800, extraOverheadCents: 0.5,
  },
};

export const defaultInstanceType = "m7g.large";

// Time limits students can pick (seconds). The ceiling is a setting.
const runtimeChoices = [1800, 3600, 7200, 14400, 28800, 43200, 86400];
export const defaultMaxRuntimeSeconds = 3600;

function readNumber(name, fallback) {
  const value = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== "" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function isKnownInstanceType(instanceType) {
  return Object.hasOwn(instanceTypes, instanceType);
}

function typeInfo(instanceType) {
  if (!isKnownInstanceType(instanceType)) {
    throw new Error(`Unknown instance type: ${instanceType}`);
  }
  return instanceTypes[instanceType];
}

// Settings per type use the type in the name: g6e.2xlarge -> G6E_2XLARGE.
const envSuffix = (instanceType) => instanceType.toUpperCase().replace(/[^A-Z0-9]/g, "_");

// Which launch template (AMI) the type runs on: "cpu" or "gpu".
export function imageFor(instanceType) {
  return typeInfo(instanceType).image || "cpu";
}

export function isGpuType(instanceType) {
  return isKnownInstanceType(instanceType) && Boolean(instanceTypes[instanceType].gpu);
}

export function gpuInstanceTypes() {
  return Object.keys(instanceTypes).filter(isGpuType);
}

export function maxRuntimeCeilingSeconds(instanceType = null) {
  const global = readNumber("EC2_MAX_RUNTIME_CEILING_SECONDS", 86400) || 86400;
  if (!instanceType) {
    return global;
  }
  const own = readNumber(`EC2_MAX_RUNTIME_CEILING_SECONDS_${envSuffix(instanceType)}`, typeInfo(instanceType).maxRuntimeSeconds ?? global);
  return Math.min(global, own || global);
}

// The time limits on offer: for one type, or (no type) under the global ceiling.
export function runtimeOptions(instanceType = null) {
  const ceiling = maxRuntimeCeilingSeconds(instanceType);
  return runtimeChoices.filter((seconds) => seconds <= ceiling);
}

export function isAllowedRuntime(seconds, instanceType = null) {
  return runtimeOptions(instanceType).includes(Number(seconds));
}

// Costs not in the per-second instance rate: the public IPv4 address (about
// 0.5 cents/h) and the root volume (about 0.3 cents/h for 30 GB; GPU templates
// have bigger volumes, see extraOverheadCents).
function overheadCentsPerHour(instanceType) {
  return readNumber("JOB_RATE_OVERHEAD_CENTS_PER_HOUR", 1) + (typeInfo(instanceType).extraOverheadCents || 0);
}

// Time billed before and after the user's script: boot, setup, upload,
// shutdown. Added to the time limit when reserving.
export function bootAllowanceSeconds(instanceType = null) {
  const global = readNumber("JOB_BOOT_ALLOWANCE_SECONDS", 300);
  if (!instanceType || !isKnownInstanceType(instanceType)) {
    return global;
  }
  return Math.max(global, typeInfo(instanceType).bootAllowanceSeconds || 0);
}

// Rate charged to students for this instance type, overhead included.
export function hourlyRateCentsFor(instanceType) {
  return Math.round((typeInfo(instanceType).cents + overheadCentsPerHour(instanceType)) * 10000) / 10000;
}

// The most a job can cost: the time limit plus the allowance, rounded up.
export function reservationCentsFor(hourlyRateCents, maxRuntimeSeconds, instanceType = null) {
  return Math.max(1, Math.ceil((Number(hourlyRateCents) * (Number(maxRuntimeSeconds) + bootAllowanceSeconds(instanceType))) / 3600));
}

// What the submit form offers, with each type's own time limits and the
// reservation for every one, so the client never repeats the pricing formula.
// includeGpu: false hides GPU types (they are admin-only by default).
export function listInstanceOptions({ includeGpu = true } = {}) {
  return Object.keys(instanceTypes)
    .filter((instanceType) => includeGpu || !isGpuType(instanceType))
    .map((instanceType) => {
      const { vcpus, memoryGb, gpu = null, gpuMemoryGb = null } = instanceTypes[instanceType];
      const hourlyRateCents = hourlyRateCentsFor(instanceType);
      const runtimeSeconds = runtimeOptions(instanceType);
      return {
        instanceType,
        vcpus,
        memoryGb,
        gpu,
        gpuMemoryGb,
        hourlyRateCents,
        runtimeSeconds,
        reserveCentsByRuntime: Object.fromEntries(
          runtimeSeconds.map((seconds) => [seconds, reservationCentsFor(hourlyRateCents, seconds, instanceType)]),
        ),
      };
    });
}
