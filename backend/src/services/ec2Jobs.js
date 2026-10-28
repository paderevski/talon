import { BudgetError } from "../budget/ledger.js";
import { JobLimitError } from "../repositories/postgres/jobsPostgresRepository.js";
import {
  bootAllowanceSeconds,
  defaultInstanceType,
  defaultMaxRuntimeSeconds,
  hourlyRateCentsFor,
  isAllowedRuntime,
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
});

// Starts a job on its own EC2 instance. Order matters:
//   1. create the job and reserve its maximum cost (one transaction; fails
//      with 402 when the budget does not cover it),
//   2. launch (clone, ship to S3, RunInstances), and save the execution ref,
//   3. if the launch fails, finalize the job as failed, which refunds the
//      whole reservation. Launching is synchronous: no retry or queue yet.
export async function launchEc2Job({ jobsRepository, adapter, user, isAdmin, payload }) {
  const instanceType = String(payload.instanceType || defaultInstanceType);
  if (!isKnownInstanceType(instanceType)) {
    throw badRequest(`Unknown instance type: ${instanceType}`);
  }
  const maxRuntimeSeconds = Number(payload.maxRuntimeSeconds ?? defaultMaxRuntimeSeconds);
  if (!isAllowedRuntime(maxRuntimeSeconds)) {
    throw badRequest("That time limit is not available");
  }
  const environment = parseEnvironmentVariables(payload.environmentVariables);

  const hourlyRateCents = hourlyRateCentsFor(instanceType);
  const spec = {
    name: payload.name || "untitled-job",
    repo: payload.repo || "unknown/repo",
    branch: payload.branch || "main",
    entryScript: payload.entryScript || "train.py",
    maxRuntimeSeconds,
    instanceType,
    environment,
    ownerUsername: user.username,
  };
  const limits = ec2JobLimits();

  const job = await jobsRepository.createWithReservation({
    ownerUserId: user.id,
    name: spec.name,
    repo: spec.repo,
    branch: spec.branch,
    entryScript: spec.entryScript,
    executionProvider: "ec2",
    computeType: instanceType,
    hourlyRateCents,
    maxRuntimeSeconds,
    reserveCents: reservationCentsFor(hourlyRateCents, maxRuntimeSeconds),
    enforceBalance: !isAdmin,
    maxUnfinishedPerUser: isAdmin ? null : limits.perUser,
    maxUnfinishedTotal: limits.total,
  });

  try {
    const executionRef = await adapter.start({ ...spec, jobId: job.id });
    return await jobsRepository.setExecutionRef(job.id, executionRef);
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
}

// HTTP status for errors the caller can fix or wait out; null for the rest.
export function launchErrorStatus(error) {
  if (error instanceof BudgetError) return 402;
  if (error instanceof JobLimitError) return 429;
  return null;
}

export { bootAllowanceSeconds };
