import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  DescribeInstancesCommand,
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { normalizeFolder } from "talon-shared/repo";
import { defaultInstanceType, imageFor, isKnownInstanceType } from "../ec2Rates.js";
import { prepareCodeSnapshot } from "../../sources/index.js";
import { formatBytes } from "../../sources/snapshot.js";
import { jobInputKey, jobLaunchPrefix } from "../../storage/keys.js";

// One EC2 instance per job. The web server fetches the job's code (any
// source, see ../../sources), packs it as a snapshot, ships it to S3,
// launches an instance from the Talon launch template, and later reads
// status.json, logs and outputs back from S3 (see infra/ec2/job_boot.sh for
// the instance side). The adapter keeps no state of its own: everything it
// needs is in the execution ref saved on the job row and in S3.

// Beyond the time limit before a job counts as failed and the reconciler
// terminates its instance. Deliberately the last line of defence: the script's
// own `timeout` fires at the limit and the instance's failsafe shutdown at
// limit + 15 minutes (job_boot.sh), so this is failsafe + 5 minutes.
export const overrunGraceSeconds = 1200;

const retryInNextSubnet = new Set(["InsufficientInstanceCapacity", "Unsupported"]);

const outputSources = [
  ["output", "output_dir"],
  ["changed", "repo_changed"],
];

const ssmPrefix = () => process.env.TALON_SSM_PREFIX || "/talon/demo";
// The SDK does not look the region up from the instance, so say it.
const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";

// The job log has no size limit (a script can print in a loop), so it is
// never read whole: each poll asks S3 for at most logChunkBytes(). A viewer
// starting on a log bigger than that sees the first logHeadBytes() (the
// "[talon]" setup steps are there) and then the most recent chunk. Lines
// longer than logLineMaxChars() are cut. Control files (status.json and the
// like) are small by design; anything over CONTROL_FILE_MAX_BYTES is ignored.
const readLimit = (name, fallback) => {
  const value = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== "" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
};
const logChunkBytes = () => readLimit("JOB_LOG_CHUNK_BYTES", 512 * 1024);
const logHeadBytes = () => Math.min(readLimit("JOB_LOG_HEAD_BYTES", 128 * 1024), logChunkBytes());
const logLineMaxChars = () => readLimit("JOB_LOG_LINE_MAX_CHARS", 10000);
const CONTROL_FILE_MAX_BYTES = 1024 * 1024;

const NEWLINE = 0x0a;
const utf8 = new TextDecoder("utf-8"); // not fatal: bad bytes become U+FFFD

// Bytes to text, one line per entry: "\r\n" tolerated, empty lines dropped,
// long lines cut (not in the middle of a surrogate pair).
function decodeLines(bytes) {
  const max = logLineMaxChars();
  const lines = [];
  let from = 0;
  while (from < bytes.length) {
    let end = bytes.indexOf(NEWLINE, from);
    if (end === -1) {
      end = bytes.length;
    }
    let line = utf8.decode(bytes.subarray(from, end)).replace(/\r$/, "");
    if (line.length > max) {
      const last = line.charCodeAt(max - 1);
      line = `${line.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max)} … [line cut]`;
    }
    if (line.length > 0) {
      lines.push(line);
    }
    from = end + 1;
  }
  return lines;
}

// The complete lines in `bytes` (which start at a line start) and how many
// bytes they use. A trailing line without its newline is left for a later
// poll, unless the window is `full` and holds no newline at all (then it is
// one long line, cut and consumed).
function takeCompleteLines(bytes, { full = false } = {}) {
  const lastNewline = bytes.lastIndexOf(NEWLINE);
  if (lastNewline === -1) {
    return full ? { lines: decodeLines(bytes), used: bytes.length } : { lines: [], used: 0 };
  }
  return { lines: decodeLines(bytes.subarray(0, lastNewline + 1)), used: lastNewline + 1 };
}

// An invalid cursor (not a whole number >= 0) starts from the beginning.
const cleanCursor = (cursor) => (Number.isSafeInteger(cursor) && cursor > 0 ? cursor : 0);

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// The entry script is written into run.sh, so only plain relative paths pass.
export function assertEntryScript(entryScript) {
  const value = String(entryScript ?? "").trim();
  if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(value) || value.includes("..")) {
    throw httpError("Entry script path is invalid", 400);
  }
  return value;
}

// Single-quote a value for the shell.
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

// The job's folder inside the repo ("" = root), checked again here because
// it is written into run.sh.
export function assertFolder(folder) {
  const value = normalizeFolder(folder);
  if (value === null) {
    throw httpError("Folder is invalid", 400);
  }
  return value;
}

// Python setup per image (see imageFor in ec2Rates.js), run before the
// requirements are installed.
const pythonSetup = {
  // Stock Ubuntu: a venv only when there are requirements to install.
  cpu: [],
  // PyTorch Deep Learning AMI: torch lives in the /opt/pytorch venv (Python
  // 3.13), which the student user cannot write to. The job gets its own venv
  // on the same Python with a .pth file that adds /opt/pytorch's packages, so
  // a requirements.txt listing torch installs nothing, and a different pinned
  // version installs into the job venv and wins (checked on g4dn 2026-11-04).
  gpu: [
    "DLAMI_PY=/opt/pytorch/bin/python3",
    `BASE_PY=$("$DLAMI_PY" -c 'import sys; print(f"{sys.base_prefix}/bin/python{sys.version_info[0]}.{sys.version_info[1]}")')`,
    '"$BASE_PY" -m venv /work/venv || { echo "Could not create the Python environment"; exit 1; }',
    `"$DLAMI_PY" -c 'import sysconfig; print(sysconfig.get_path("purelib"))' > "$(/work/venv/bin/python -c 'import sysconfig; print(sysconfig.get_path("purelib"))')/talon-dlami.pth"`,
    ". /work/venv/bin/activate",
  ],
};

// Runs from the job's folder: its requirements.txt is installed (else the
// repo root's), and the entry script path is relative to it.
export function buildRunScript(entryScript, environment = [], folder = "", scriptArgs = [], { image = "cpu" } = {}) {
  const dir = assertFolder(folder);
  const workDir = dir ? `/work/repo/${dir}` : "/work/repo";
  if (!Object.hasOwn(pythonSetup, image)) {
    throw httpError(`Unknown image: ${image}`, 500);
  }
  const install = image === "cpu"
    ? '  python3 -m venv /work/venv && . /work/venv/bin/activate && pip install --progress-bar off -r "$REQS" || { echo "pip install failed"; exit 1; }'
    : '  pip install --progress-bar off -r "$REQS" || { echo "pip install failed"; exit 1; }';
  return [
    "#!/bin/bash",
    "# Generated by Talon. Runs as the unprivileged user, with a time limit.",
    "export TALON_OUTPUT_DIR=/work/output",
    // Large data: local NVMe on GPU types, else the root volume; not saved (job_boot.sh).
    "export TALON_SCRATCH_DIR=/work/scratch",
    // Output goes to a file, so Python would buffer it; a killed job (time limit)
    // would lose it, and live logs would lag.
    "export PYTHONUNBUFFERED=1",
    ...environment.map(({ name, value }) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw httpError("Invalid environment variable name", 400);
      }
      return `export ${name}=${shellQuote(value)}`;
    }),
    `cd '${workDir}' || { echo "Folder not found: ${dir}"; exit 1; }`,
    ...pythonSetup[image],
    "REQS=",
    "if [ -f requirements.txt ]; then REQS=requirements.txt; elif [ -f /work/repo/requirements.txt ]; then REQS=/work/repo/requirements.txt; fi",
    'if [ -n "$REQS" ]; then',
    '  echo "Installing $REQS"',
    install,
    "fi",
    `exec python3 -u '${assertEntryScript(entryScript)}'${scriptArgs.map((arg) => ` ${shellQuote(arg)}`).join("")}`,
    "",
  ].join("\n");
}

export default function createEc2ExecutionAdapter({
  ec2 = new EC2Client({ region }),
  s3 = new S3Client({ region }),
  ssm = new SSMClient({ region }),
  config = null, // { bucket, launchTemplateId, subnetIds }; default: env, then SSM
  prepareInput = prepareCodeSnapshot, // (spec) -> { workDir, archive, bytes?, sha256?, ref? }; replaced in tests
  now = () => Date.now(),
  newLaunchId = () => randomBytes(16).toString("hex"), // 128 random bits; replaced in tests
} = {}) {
  let configPromise = null;
  const getConfig = () => {
    if (!configPromise) {
      configPromise = (async () => {
        if (config) {
          return config;
        }
        // Setting name in SSM (under the prefix) -> environment variable.
        // The GPU template is optional: without it GPU launches get a 503.
        const settings = {
          "jobs-bucket": "JOBS_BUCKET",
          "jobs-launch-template-id": "JOB_LAUNCH_TEMPLATE_ID",
          "jobs-subnet-ids": "JOB_SUBNET_IDS",
          "jobs-gpu-launch-template-id": "JOB_LAUNCH_TEMPLATE_ID_GPU",
        };
        const values = Object.fromEntries(Object.entries(settings).map(([n, envName]) => [n, process.env[envName] || ""]));
        const missing = Object.keys(values).filter((n) => !values[n]);
        if (missing.length > 0) {
          const result = await ssm.send(new GetParametersCommand({ Names: missing.map((n) => `${ssmPrefix()}/${n}`) }));
          for (const n of missing) {
            values[n] = result.Parameters?.find((p) => p.Name === `${ssmPrefix()}/${n}`)?.Value || "";
          }
        }
        const subnetIds = values["jobs-subnet-ids"].split(",").map((s) => s.trim()).filter(Boolean);
        if (!values["jobs-bucket"] || !values["jobs-launch-template-id"] || subnetIds.length === 0) {
          throw httpError("EC2 job settings are missing (jobs bucket, launch template or subnets)", 503);
        }
        return {
          bucket: values["jobs-bucket"],
          launchTemplateId: values["jobs-launch-template-id"],
          launchTemplateIds: { gpu: values["jobs-gpu-launch-template-id"] || null },
          subnetIds,
        };
      })().catch((error) => {
        configPromise = null; // retry next call
        throw error;
      });
    }
    return configPromise;
  };

  // Each launch gets its own S3 folder, jobs/<job id>-<random>, stored on the
  // job (executionRef.s3Prefix) and passed to the instance as the
  // talon-s3-prefix tag. Job ids can repeat (a new database restarts them)
  // while old folders live on for jobs_retention_days; a folder named by the
  // id alone would hand a new job an old job's status, logs and files. The
  // random part also keeps other jobs' folders unguessable from inside a job
  // (the job role is shared; see jobs.tf).
  const launchPrefixPattern = /^jobs\/[A-Za-z0-9-]+$/;
  const prefix = (ref) => {
    const value = String(ref?.s3Prefix ?? "");
    if (!launchPrefixPattern.test(value)) {
      throw new Error(`Job ${ref?.jobId ?? "?"} has no valid S3 folder (executionRef.s3Prefix)`);
    }
    return value;
  };
  let nextSubnet = 0;

  // bytes [start, end] of an object, with the object's total size (S3 reports
  // it in ContentRange). null: no such object, or nothing at or after start
  // (S3 answers 416 InvalidRange, also for an empty object).
  async function readRange(bucket, key, start, end) {
    try {
      const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=${start}-${end}` }));
      const bytes = await out.Body.transformToByteArray();
      const total = Number(/\/(\d+)$/.exec(out.ContentRange ?? "")?.[1]);
      return { bytes, total: Number.isFinite(total) ? total : start + bytes.length, modifiedAt: out.LastModified ?? null };
    } catch (error) {
      const status = error?.$metadata?.httpStatusCode;
      if (error?.name === "NoSuchKey" || error?.name === "InvalidRange" || status === 404 || status === 416) {
        return null;
      }
      throw error;
    }
  }

  // Small control files only: a bigger object is treated as unreadable, the
  // same way malformed JSON is.
  async function readText(bucket, key) {
    const part = await readRange(bucket, key, 0, CONTROL_FILE_MAX_BYTES);
    if (part === null || part.bytes.length > CONTROL_FILE_MAX_BYTES) {
      return null;
    }
    return { text: utf8.decode(part.bytes), modifiedAt: part.modifiedAt };
  }

  // The parsed file plus when S3 stored it (LastModified: set by S3, the
  // writer cannot choose it), or null.
  async function readJson(bucket, key) {
    const file = await readText(bucket, key);
    if (file === null) {
      return null;
    }
    try {
      const value = JSON.parse(file.text);
      return value === null || typeof value !== "object" ? null : { value, modifiedAt: file.modifiedAt };
    } catch {
      return null;
    }
  }

  // When the web server saw a control file land: the time S3 stored it, never
  // later than now. The job's own clock (status.updated_at, cancelled.at) is
  // for display only: the job instance can write those files, so billing
  // must not depend on what they claim. With no usable S3 time, now.
  const observedAt = (modifiedAt) => {
    const stored = modifiedAt ? new Date(modifiedAt).getTime() : NaN;
    return Number.isFinite(stored) ? Math.min(stored, now()) : now();
  };

  // The last logChunkBytes() of the log, from the start of a line: the line
  // cut by the window's edge is dropped (one byte is read before the window to
  // tell whether the edge is a line start). start: offset of the first line
  // returned; next: where to continue (after the last newline).
  async function readLogTail(bucket, key, total) {
    const windowStart = total - logChunkBytes() + 1;
    const part = await readRange(bucket, key, windowStart - 1, total - 1);
    const bytes = part?.bytes ?? new Uint8Array(0);
    const firstNewline = bytes[0] === NEWLINE ? 0 : bytes.indexOf(NEWLINE);
    if (firstNewline === -1) {
      // No newline anywhere: one very long line, shown cut.
      return { start: windowStart, lines: decodeLines(bytes.subarray(1)), next: total };
    }
    const start = windowStart + firstNewline;
    const taken = takeCompleteLines(bytes.subarray(firstNewline + 1));
    return { start, lines: taken.lines, next: start + taken.used };
  }

  async function describeInstance(instanceId) {
    try {
      const out = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
      const instance = out.Reservations?.[0]?.Instances?.[0];
      return instance
        ? { state: instance.State?.Name, launchTime: instance.LaunchTime ? new Date(instance.LaunchTime).toISOString() : null }
        : null;
    } catch (error) {
      if (String(error?.name || error?.Code || "").startsWith("InvalidInstanceID")) {
        return null;
      }
      throw error;
    }
  }

  async function terminate(instanceId) {
    try {
      await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
    } catch (error) {
      if (!String(error?.name || "").startsWith("InvalidInstanceID")) {
        throw error;
      }
    }
  }

  return {
    provider: "ec2",

    async start(jobSpec) {
      const cfg = await getConfig();
      const jobId = String(jobSpec?.jobId || "").trim();
      if (!/^[A-Za-z0-9-]+$/.test(jobId)) {
        throw httpError("A job id is required to launch on EC2", 500);
      }
      const instanceType = jobSpec.instanceType || defaultInstanceType;
      if (!isKnownInstanceType(instanceType)) {
        throw httpError(`Instance type not allowed: ${instanceType}`, 400);
      }
      // The CPU template is arm64; GPU types are x86_64 on their own templates.
      const image = imageFor(instanceType);
      const launchTemplateId = image === "cpu" ? cfg.launchTemplateId : cfg.launchTemplateIds?.[image];
      if (!launchTemplateId) {
        throw httpError(`${instanceType} is not set up on this server (no ${image} launch template)`, 503);
      }
      const maxRuntimeSeconds = Math.floor(Number(jobSpec.maxRuntimeSeconds));
      if (!(maxRuntimeSeconds > 0)) {
        throw httpError("A time limit is required to launch on EC2", 500);
      }

      const launchId = newLaunchId();
      if (!/^[a-f0-9]{16,64}$/.test(launchId)) {
        throw httpError("Could not make a launch id", 500);
      }
      const s3Prefix = jobLaunchPrefix(jobId, launchId);

      // The snapshot: job_boot.sh unpacks input/repo.tgz into /work/repo.
      assertEntryScript(jobSpec.entryScript);
      assertFolder(jobSpec.folder);
      const snapshotKey = jobInputKey(s3Prefix);
      const progress = typeof jobSpec.onProgress === "function" ? jobSpec.onProgress : () => {};
      const prepared = await prepareInput(jobSpec);
      progress(prepared.bytes ? `Uploading the code to S3 (${formatBytes(prepared.bytes)})` : "Uploading the code to S3");
      try {
        await s3.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: snapshotKey, Body: await readFile(prepared.archive) }));
        await s3.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: jobInputKey(s3Prefix, "run.sh"), Body: buildRunScript(jobSpec.entryScript, jobSpec.environment, jobSpec.folder, jobSpec.scriptArgs || [], { image }) }));
      } finally {
        await rm(prepared.workDir, { recursive: true, force: true });
      }
      // What the job runs from, for its code input (job_inputs). Not part of
      // the execution ref: launchEc2Job stores it separately.
      const input = {
        snapshotKey,
        sha256: prepared.sha256 ?? null,
        bytes: prepared.bytes ?? null,
        ref: prepared.ref ?? null,
      };

      // Cancelled while the code was being prepared: start nothing.
      if (await jobSpec.isCancelled?.()) {
        throw httpError("Cancelled before an instance was started", 499);
      }
      progress(`Starting a ${instanceType} instance`);

      const tags = [
        { Key: "Project", Value: "talon" },
        { Key: "Component", Value: "job" },
        { Key: "talon-job", Value: jobId },
        { Key: "talon-s3-prefix", Value: s3Prefix }, // job_boot.sh reads and writes only here
        { Key: "talon-max-seconds", Value: String(maxRuntimeSeconds) },
        { Key: "talon-owner", Value: String(jobSpec.ownerUsername || "unknown").slice(0, 120) },
      ];

      // Start at a different subnet each launch so jobs spread over the zones,
      // then try the others in turn.
      const first = nextSubnet++ % cfg.subnetIds.length;
      const subnets = [...cfg.subnetIds.slice(first), ...cfg.subnetIds.slice(0, first)];
      let lastError = null;
      for (const subnetId of subnets) {
        try {
          const out = await ec2.send(
            new RunInstancesCommand({
              LaunchTemplate: { LaunchTemplateId: launchTemplateId, Version: "$Default" },
              InstanceType: instanceType,
              SubnetId: subnetId,
              MinCount: 1,
              MaxCount: 1,
              // One per attempt (a failed launch may keep its token), and per
              // launch: a token built from a reusable job id could return an
              // old job's instance instead of launching a new one.
              ClientToken: `talon-${launchId}-${subnetId}`.slice(0, 64),
              TagSpecifications: [{ ResourceType: "instance", Tags: tags }],
            }),
          );
          const instance = out.Instances?.[0];
          return {
            provider: "ec2",
            executionId: jobId,
            jobId,
            s3Prefix,
            instanceId: instance.InstanceId,
            instanceType,
            subnetId,
            maxRuntimeSeconds,
            submittedAt: new Date(now()).toISOString(),
            launchedAt: instance.LaunchTime ? new Date(instance.LaunchTime).toISOString() : new Date(now()).toISOString(),
            input,
          };
        } catch (error) {
          lastError = error;
          // Try the next subnet only when this zone has no capacity for the
          // type or does not offer it at all (not every type is in every zone).
          if (!retryInNextSubnet.has(error?.name)) {
            break;
          }
        }
      }
      // Every zone said no capacity (or does not offer the type): AWS's own
      // message names one zone and suggests others we just tried, so say
      // what happened instead. 503: worth trying again later.
      if (retryInNextSubnet.has(lastError?.name)) {
        const zones = subnets.length === 1 ? "the one zone Talon uses" : `all ${subnets.length} zones Talon uses`;
        throw httpError(`No ${instanceType} machines are available right now (AWS has no capacity in ${zones}). Try again later or choose another machine.`, 503);
      }
      // AWS's text stays in the server log (detail), not in the reply.
      const launchError = httpError("Could not launch a machine. Try again in a few minutes.", 502);
      launchError.detail = `${lastError?.name || "unknown error"}${lastError?.message ? ` (${lastError.message})` : ""}`;
      throw launchError;
    },

    async getStatus(ref) {
      const cfg = await getConfig();
      const [statusFile, cancelledFile, instance] = await Promise.all([
        readJson(cfg.bucket, `${prefix(ref)}/status.json`),
        readJson(cfg.bucket, `${prefix(ref)}/control/cancelled`),
        describeInstance(ref.instanceId),
      ]);

      const status = statusFile?.value ?? null;
      const cancelled = cancelledFile?.value ?? null;

      // Billing starts at EC2's launch time for the instance (RunInstances
      // answer, saved in the ref), which is also when AWS starts charging.
      const startedAt = ref.launchedAt || instance?.launchTime || null;
      const base = { submittedAt: ref.submittedAt || null, startedAt, endedAt: null, exitCode: null };
      const deadlineMs = startedAt
        ? new Date(startedAt).getTime() + (Number(ref.maxRuntimeSeconds) + overrunGraceSeconds) * 1000
        : null;

      // The end of a job that reported (or was cancelled) is when S3 stored
      // that file, not what is written in it. Never before the start.
      const observedEnd = (modifiedAt) => {
        const ended = observedAt(modifiedAt);
        return new Date(startedAt ? Math.max(ended, new Date(startedAt).getTime()) : ended).toISOString();
      };

      if (status && ["succeeded", "failed", "timeout"].includes(status.state)) {
        const endedAt = observedEnd(statusFile.modifiedAt);
        return {
          ...base,
          state: status.state === "succeeded" ? "completed" : "failed",
          endedAt,
          // What the job says, for display only.
          reportedAt: status.updated_at || null,
          exitCode: Number.isFinite(status.exit_code) ? status.exit_code : null,
          // From the observed time, so both web servers agree on the key and
          // the job cannot make a new one by rewriting its own updated_at.
          syncKey: `status:${statusFile.modifiedAt ? endedAt : status.state}`,
          // The job's own result (status.json), as opposed to an inference.
          reported: true,
          message: status.message || (status.state === "timeout" ? "Time limit reached" : undefined),
        };
      }

      if (cancelled) {
        return { ...base, state: "cancelled", endedAt: observedEnd(cancelledFile.modifiedAt), syncKey: "cancelled" };
      }

      if (deadlineMs !== null && now() > deadlineMs) {
        return {
          ...base,
          state: "failed",
          endedAt: new Date(deadlineMs).toISOString(),
          syncKey: "overrun",
          message: "Time limit exceeded",
        };
      }

      // An EC2 job counts as running from submit (the code is prepared,
      // then the instance boots): "queued" is for jobs waiting their turn.
      if (!instance) {
        // Right after launch the instance may not be visible yet.
        if (now() - new Date(ref.submittedAt || 0).getTime() < 2 * 60 * 1000) {
          return { ...base, state: "running" };
        }
        throw httpError("Execution not found", 404);
      }

      if (instance.state === "pending") {
        return { ...base, state: "running" };
      }
      if (instance.state === "running") {
        return { ...base, state: "running" };
      }

      // Gone (or going) without a result: it died before reporting.
      const ended = deadlineMs !== null ? Math.min(now(), deadlineMs) : now();
      return {
        ...base,
        state: "failed",
        endedAt: new Date(ended).toISOString(),
        syncKey: `ended:${ref.instanceId}`,
        message: "The instance ended without reporting a result",
      };
    },

    // The cursor is a byte offset into logs/job.log, which only ever grows
    // (the instance re-uploads the growing file), and always sits just after
    // a newline. Reads are bounded, see logChunkBytes above. A cursor from
    // before byte offsets (a line count) is read as a byte offset: at worst it
    // starts in the middle of a line once.
    async getLogs(ref, cursor = 0) {
      const cfg = await getConfig();
      const key = `${prefix(ref)}/logs/job.log`;
      const chunk = logChunkBytes();
      const head = logHeadBytes();
      const start = cleanCursor(cursor);
      // The reply to this read also says how big the log is.
      const part = await readRange(cfg.bucket, key, start, start + chunk - 1);
      if (part === null) {
        return { lines: [], nextCursor: start }; // no log yet, or a cursor past its end
      }
      const behind = part.total - start > chunk;
      // A first read just over one chunk is read in two polls, not cut in two
      // pieces with the head and the tail overlapping.
      if (!behind || (start === 0 && part.total <= chunk + head)) {
        const taken = takeCompleteLines(part.bytes, { full: part.bytes.length >= chunk });
        return { lines: taken.lines, nextCursor: start + taken.used };
      }

      // More new output than one chunk: the beginning (first read only), a
      // note about what is skipped, and the most recent lines.
      const tail = await readLogTail(cfg.bucket, key, part.total);
      const first = start === 0 ? takeCompleteLines(part.bytes.subarray(0, head), { full: true }) : { lines: [], used: start };
      const skipped = formatBytes(tail.start - first.used);
      const note = `[log] … ${skipped} of output not shown; showing the most recent lines …`;
      return { lines: [...first.lines, note, ...tail.lines], nextCursor: tail.next };
    },

    // Two sources, as with the local runner: files the script wrote to
    // TALON_OUTPUT_DIR (output/) and files it created or changed in its
    // repository directory (changed/).
    async listOutputFiles(ref) {
      const cfg = await getConfig();
      const files = [];
      for (const [folder, source] of outputSources) {
        const folderPrefix = `${prefix(ref)}/${folder}/`;
        let token;
        do {
          const out = await s3.send(new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: folderPrefix, ContinuationToken: token }));
          for (const item of out.Contents ?? []) {
            const name = item.Key.slice(folderPrefix.length);
            if (name && !name.endsWith("/")) {
              files.push({ name, size: formatBytes(item.Size), source });
            }
          }
          token = out.IsTruncated ? out.NextContinuationToken : undefined;
        } while (token);
      }
      return files;
    },

    // For the download route: a readable stream of one output file.
    async openOutputFile(ref, name, source = "output_dir") {
      const cfg = await getConfig();
      const clean = String(name || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
      if (!clean || clean.split("/").includes("..")) {
        throw httpError("Invalid file name", 400);
      }
      const folder = String(source).toLowerCase() === "repo_changed" ? "changed" : "output";
      try {
        const out = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: `${prefix(ref)}/${folder}/${clean}` }));
        return { stream: out.Body, size: out.ContentLength, downloadName: path.basename(clean) };
      } catch (error) {
        if (error?.name === "NoSuchKey") {
          throw httpError("File not found", 404);
        }
        throw error;
      }
    },

    async cancel(ref) {
      const cfg = await getConfig();
      await s3.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: `${prefix(ref)}/control/cancelled`,
          Body: JSON.stringify({ at: new Date(now()).toISOString() }),
        }),
      );
      await terminate(ref.instanceId);
      return { ok: true, state: "cancelling" };
    },

    // For the reconciler.
    async terminateInstance(instanceId) {
      await terminate(instanceId);
    },

    // Every live job instance, found by tag (including ones no job row knows).
    async listJobInstances() {
      const found = [];
      let token;
      do {
        const out = await ec2.send(
          new DescribeInstancesCommand({
            Filters: [
              { Name: "tag:Project", Values: ["talon"] },
              { Name: "tag:Component", Values: ["job"] },
              { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] },
            ],
            NextToken: token,
          }),
        );
        for (const reservation of out.Reservations ?? []) {
          for (const instance of reservation.Instances ?? []) {
            found.push({
              instanceId: instance.InstanceId,
              jobId: instance.Tags?.find((t) => t.Key === "talon-job")?.Value || null,
              state: instance.State?.Name,
              launchTime: instance.LaunchTime ? new Date(instance.LaunchTime).toISOString() : null,
            });
          }
        }
        token = out.NextToken;
      } while (token);
      return found;
    },
  };
}
