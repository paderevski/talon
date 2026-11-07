import { parseScriptArgs } from "../utils/scriptArgs.js";
import { BudgetError } from "../budget/ledger.js";
import { JobLimitError } from "../repositories/postgres/jobsPostgresRepository.js";
import { parseCodeSource } from "../sources/index.js";
import { log } from "../utils/log.js";
import {
  bootAllowanceSeconds,
  defaultInstanceType,
  defaultMaxRuntimeSeconds,
  gpuInstanceTypes,
  hourlyRateCentsFor,
  isAllowedRuntime,
  isGpuType,
  isKnownInstanceType,
  reservationCentsFor,
} from "../execution/ec2Rates.js";

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

// Names a job may not set: they would change how the script is run.
const reservedEnvNames = /^(PATH|HOME|USER|SHELL|LD_.*|TALON_.*|PYTHONUNBUFFERED|BASH_ENV|ENV|IFS)$/;

// "NAME=value" lines from the submit form. Strict on names, so nothing can
// be injected into the generated run.sh (values are quoted there).
export function parseEnvironmentVariables(text) {
  const variables = [];
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) {
      throw badRequest(`Environment variable lines must look like NAME=value: "${line.slice(0, 40)}"`);
    }
    if (reservedEnvNames.test(match[1])) {
      throw badRequest(`${match[1]} cannot be set`);
    }
    if (match[2].length > 1000 || /[\0]/.test(match[2])) {
      throw badRequest(`Value of ${match[1]} is not allowed`);
    }
    variables.push({ name: match[1], value: match[2] });
  }
  if (variables.length > 50) {
    throw badRequest("At most 50 environment variables");
  }
  return variables;
}

function readLimit(name, fallback) {
  const raw = process.env[name];
  const value = Number(raw);
  return raw !== undefined && raw !== "" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

// Per-user and system-wide limits on unfinished EC2 jobs (admins are exempt
// from the per-user one so they can test).
export const ec2JobLimits = () => ({
  perUser: readLimit("EC2_MAX_JOBS_PER_USER", 1),
  total: readLimit("EC2_MAX_JOBS_TOTAL", 10),
  gpuTotal: readLimit("EC2_MAX_GPU_JOBS_TOTAL", 3), // GPU jobs at once, everyone together
});

// GPU machines are for admins only unless EC2_GPU_ADMIN_ONLY=false.
export const gpuAllowed = (isAdmin) => isAdmin || process.env.EC2_GPU_ADMIN_ONLY === "false";

// Starts a job on its own EC2 instance. Order matters:
//   1. create the job and reserve its maximum cost (one transaction; fails
//      with 402 when the budget does not cover it),
//   2. launch (clone, ship to S3, RunInstances), and save the execution ref,
//   3. if the launch fails, finalize the job as failed, which refunds the
//      whole reservation. Launching is synchronous: no retry or queue yet.
//   4. record what the job's code input ran from (snapshot, git commit).
// source: the parsed code source ({ type, ref, label }; default: parsed
// from the payload). credential: what the source fetches with (for GitHub,
// an installation token for a private repo; null: anonymous). Passed to the
// adapter only, never stored.
export async function launchEc2Job({ jobsRepository, adapter, user, isAdmin, payload, source = null, credential = null }) {
  const code = source ?? parseCodeSource(payload);
  const instanceType = String(payload.instanceType || defaultInstanceType);
  if (!isKnownInstanceType(instanceType)) {
    throw badRequest(`Unknown instance type: ${instanceType}`);
  }
  const gpu = isGpuType(instanceType);
  if (gpu && !gpuAllowed(isAdmin)) {
    const error = new Error("GPU machines are limited to admins right now");
    error.status = 403;
    throw error;
  }
  const maxRuntimeSeconds = Number(payload.maxRuntimeSeconds ?? defaultMaxRuntimeSeconds);
  if (!isAllowedRuntime(maxRuntimeSeconds, instanceType)) {
    throw badRequest("That time limit is not available");
  }
  const environment = parseEnvironmentVariables(payload.environmentVariables);

  const hourlyRateCents = hourlyRateCentsFor(instanceType);
  const spec = {
    name: payload.name || "untitled-job",
    source: { type: code.type, ref: code.ref },
    entryScript: payload.entryScript || "train.py",
    folder: payload.folder || "",
    scriptArgs: parseScriptArgs(payload.scriptArgs),
    maxRuntimeSeconds,
    instanceType,
    environment,
    ownerUsername: user.username,
  };
  const limits = ec2JobLimits();

  const job = await jobsRepository.createWithReservation({
    ownerUserId: user.id,
    name: spec.name,
    source: code,
    entryScript: spec.entryScript,
    folder: spec.folder,
    scriptArgs: String(payload.scriptArgs ?? "").trim(),
    executionProvider: "ec2",
    computeType: instanceType,
    hourlyRateCents,
    maxRuntimeSeconds,
    reserveCents: reservationCentsFor(hourlyRateCents, maxRuntimeSeconds, instanceType),
    enforceBalance: !isAdmin,
    maxUnfinishedPerUser: isAdmin ? null : limits.perUser,
    maxUnfinishedTotal: limits.total,
    ...(gpu ? { groupLimit: { computeTypes: gpuInstanceTypes(), max: limits.gpuTotal, label: "GPU jobs" } } : {}),
  });

  let launched;
  let input = null;
  try {
    const { input: ranFrom = null, ...executionRef } = await adapter.start({ ...spec, jobId: job.id, credential });
    input = ranFrom;
    launched = await jobsRepository.setExecutionRef(job.id, executionRef);
  } catch (error) {
    await jobsRepository.finalize(job.id, {
      syncKey: "launch-failed",
      status: "failed",
      neverRan: true,
      error: `Could not start the job: ${error.message}`,
      finalizedAt: new Date().toISOString(),
    });
    throw error;
  }

  // The job is running by now: failing to record its snapshot must not fail it.
  if (input) {
    try {
      return await jobsRepository.recordInputSnapshot(job.id, "code", input);
    } catch (error) {
      log.warn("could not record the job's input snapshot", { event: "job.input_record_failed", jobId: job.id, error: error.message });
    }
  }
  return launched;
}

// HTTP status for errors the caller can fix or wait out; null for the rest.
export function launchErrorStatus(error) {
  if (error instanceof BudgetError) return 402;
  if (error instanceof JobLimitError) return 429;
  return null;
}

export { bootAllowanceSeconds };
