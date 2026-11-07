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

// Starting a job on its own EC2 instance has two parts:
//
//   reserveEc2Job (quick, in the submit request): check the request, create
//     the job and reserve its maximum cost in one transaction (402 when the
//     budget does not cover it, 429 at a job limit). The job is "queued"
//     with no execution ref: it is being prepared.
//   runEc2Launch (slow, in the background on the same web server): fetch
//     and pack the code, upload it, RunInstances, save the execution ref and
//     the input snapshot. Each step is recorded as the job's launch progress.
//     If it fails, the job is finalized as failed, which refunds the whole
//     reservation. If the job was cancelled meanwhile (it is already
//     finished), nothing is started.
//
// startEc2Job does the first and kicks off the second (the submit route);
// launchEc2Job does both and waits (tests, scripts).
// source: the parsed code source ({ type, ref, label }; default: parsed
// from the payload). credential: what the source fetches with (for GitHub,
// an installation token for a private repo; null: anonymous). Passed to the
// adapter only, never stored.
export async function reserveEc2Job({ jobsRepository, user, isAdmin, payload, source = null }) {
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
  return { job, spec };
}

const isFinished = (job) => !job || job.status === "completed" || job.status === "failed" || Boolean(job.resultSyncKey);

// The slow part; never throws (failures finalize the job). Returns the job
// as it ends up. `log` and `checkEveryMs` are replaceable for tests.
export async function runEc2Launch({ jobsRepository, adapter, job, spec, credential = null, checkEveryMs = 5000 }) {
  // Progress lines, written in order and at most every 2 s (plus the last).
  let pending = Promise.resolve();
  let lastWrite = 0;
  let queued = null;
  const flush = (text) => {
    lastWrite = Date.now();
    pending = pending.then(() => jobsRepository.setLaunchProgress(job.id, text)).catch(() => {});
  };
  const onProgress = (text) => {
    queued = text;
    if (Date.now() - lastWrite >= 2000) {
      flush(text);
      queued = null;
    }
  };

  // Cancelled (or failed elsewhere) while preparing: the job row is
  // already finished. Checked before starting an instance, and every few
  // seconds to stop a long copy early.
  const abort = new AbortController();
  const isCancelled = async () => isFinished(await jobsRepository.findById(job.id));
  const watcher = setInterval(() => {
    isCancelled().then((stop) => stop && abort.abort()).catch(() => {});
  }, checkEveryMs);
  watcher.unref?.();

  let launched = null;
  let input = null;
  try {
    const { input: ranFrom = null, ...executionRef } = await adapter.start({
      ...spec, jobId: job.id, credential, onProgress, signal: abort.signal, isCancelled,
    });
    input = ranFrom;
    launched = await jobsRepository.setExecutionRef(job.id, executionRef);
  } catch (error) {
    clearInterval(watcher);
    if (queued) flush(queued);
    await pending;
    if (await isCancelled()) {
      log.info("launch stopped: the job was cancelled", { event: "job.launch_cancelled", jobId: job.id });
      return jobsRepository.findById(job.id);
    }
    const status = launchErrorStatus(error) || error?.status || 500;
    (status >= 500 ? log.error : log.info)("job not started", {
      event: "job.launch_failed",
      jobId: job.id,
      status,
      ...(status >= 500 ? { err: error } : { error: error?.message }),
    });
    return jobsRepository.finalize(job.id, {
      syncKey: "launch-failed",
      status: "failed",
      neverRan: true,
      error: `Could not start the job: ${error.message}`,
      finalizedAt: new Date().toISOString(),
    });
  }
  clearInterval(watcher);
  await pending;

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

// Submit: reserve now, launch in the background. Returns { job, launch }
// where launch resolves to the job once the launch has ended either way.
export async function startEc2Job({ jobsRepository, adapter, user, isAdmin, payload, source = null, credential = null }) {
  const { job, spec } = await reserveEc2Job({ jobsRepository, user, isAdmin, payload, source });
  const launch = runEc2Launch({ jobsRepository, adapter, job, spec, credential });
  return { job, launch };
}

// Both parts, waiting for the launch. Throws what the launch failed with
// (after the job is finalized), like the submit route used to.
export async function launchEc2Job({ jobsRepository, adapter, user, isAdmin, payload, source = null, credential = null }) {
  const { job, spec } = await reserveEc2Job({ jobsRepository, user, isAdmin, payload, source });
  let failure = null;
  const wrapped = { ...adapter, start: (args) => adapter.start(args).catch((error) => { failure = error; throw error; }) };
  const result = await runEc2Launch({ jobsRepository, adapter: wrapped, job, spec, credential });
  if (failure) {
    throw failure;
  }
  return result;
}

// HTTP status for errors the caller can fix or wait out; null for the rest.
export function launchErrorStatus(error) {
  if (error instanceof BudgetError) return 402;
  if (error instanceof JobLimitError) return 429;
  return null;
}

export { bootAllowanceSeconds };
