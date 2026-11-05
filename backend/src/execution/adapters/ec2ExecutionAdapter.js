import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
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
import { assertRepoPath, normalizeFolder } from "talon-shared/repo";
import { defaultInstanceType, imageFor, isKnownInstanceType } from "../ec2Rates.js";
import { describeCloneError, gitAuthEnv } from "../gitAuth.js";

const execFileAsync = promisify(execFile);

// One EC2 instance per job. The web server clones the repo, ships it to S3,
// launches an instance from the Talon launch template, and later reads
// status.json, logs and outputs back from S3 (see infra/ec2/job_boot.sh for
// the instance side). The adapter keeps no state of its own: everything it
// needs is in the execution ref saved on the job row and in S3.

const gitBin = process.env.TALON_GIT_BIN || "git";
const cloneTimeoutMs = Number(process.env.EC2_GIT_CLONE_TIMEOUT_MS || 90 * 1000);
const maxRepoBytes = Number(process.env.EC2_MAX_REPO_BYTES || 100 * 1024 * 1024);

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

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

// The entry script is written into run.sh, so only plain relative paths pass.
export function assertEntryScript(entryScript) {
  const value = String(entryScript ?? "").trim();
  if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(value) || value.includes("..")) {
    throw httpError("Entry script path is invalid", 400);
  }
  return value;
}

function assertBranch(branch) {
  const value = String(branch || "main").trim() || "main";
  if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(value) || value.includes("..")) {
    throw httpError("Branch name is invalid", 400);
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
    ? '  python3 -m venv /work/venv && . /work/venv/bin/activate && pip install --quiet -r "$REQS" || { echo "pip install failed"; exit 1; }'
    : '  pip install --quiet -r "$REQS" || { echo "pip install failed"; exit 1; }';
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

async function cloneAndPack(spec) {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "talon-ec2-"));
  try {
    const repoDir = path.join(workDir, "repo");
    await execFileAsync(
      gitBin,
      [
        "clone", "--depth", "1", "--branch", assertBranch(spec.branch),
        `https://github.com/${assertRepoPath(spec.repo)}.git`, repoDir,
      ],
      { cwd: workDir, timeout: cloneTimeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo", ...gitAuthEnv(spec.gitToken) } },
    ).catch((error) => {
      throw httpError(`Could not clone ${spec.repo}@${spec.branch}: ${describeCloneError(String(error.stderr || error.message))}`, 400);
    });

    await rm(path.join(repoDir, ".git"), { recursive: true, force: true });
    const folder = assertFolder(spec.folder);
    await stat(path.join(repoDir, folder, assertEntryScript(spec.entryScript))).catch(() => {
      throw httpError(`Entry script not found: ${folder ? `${folder}/` : ""}${spec.entryScript}`, 400);
    });

    const archive = path.join(workDir, "repo.tgz");
    await execFileAsync("tar", ["-czf", archive, "-C", repoDir, "."], { timeout: 60 * 1000 });
    if ((await stat(archive)).size > maxRepoBytes) {
      throw httpError(`Repository is larger than ${formatBytes(maxRepoBytes)}`, 400);
    }
    return { workDir, archive };
  } catch (error) {
    await rm(workDir, { recursive: true, force: true });
    throw error;
  }
}

export default function createEc2ExecutionAdapter({
  ec2 = new EC2Client({ region }),
  s3 = new S3Client({ region }),
  ssm = new SSMClient({ region }),
  config = null, // { bucket, launchTemplateId, subnetIds }; default: env, then SSM
  prepareInput = cloneAndPack, // (spec) -> { workDir, archive }; replaced in tests
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
  // (the job role is shared; see jobs.tf). Jobs launched before this keep
  // jobs/<job id>.
  const launchPrefixPattern = /^jobs\/[A-Za-z0-9-]+$/;
  const prefix = (ref) => (launchPrefixPattern.test(String(ref?.s3Prefix ?? "")) ? ref.s3Prefix : `jobs/${ref.jobId}`);
  let nextSubnet = 0;

  async function readText(bucket, key) {
    try {
      const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return await out.Body.transformToString();
    } catch (error) {
      if (error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async function readJson(bucket, key) {
    const text = await readText(bucket, key);
    if (text === null) {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
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
      const s3Prefix = `jobs/${jobId}-${launchId}`;

      const { workDir, archive } = await prepareInput(jobSpec);
      try {
        const base = `${s3Prefix}/input`;
        await s3.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: `${base}/repo.tgz`, Body: await readFile(archive) }));
        await s3.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: `${base}/run.sh`, Body: buildRunScript(jobSpec.entryScript, jobSpec.environment, jobSpec.folder, jobSpec.scriptArgs || [], { image }) }));
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }

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
      throw httpError(`Could not launch an instance: ${lastError?.name || "unknown error"}${lastError?.message ? ` (${lastError.message})` : ""}`, 502);
    },

    async getStatus(ref) {
      const cfg = await getConfig();
      const [status, cancelled, instance] = await Promise.all([
        readJson(cfg.bucket, `${prefix(ref)}/status.json`),
        readJson(cfg.bucket, `${prefix(ref)}/control/cancelled`),
        describeInstance(ref.instanceId),
      ]);

      const startedAt = ref.launchedAt || instance?.launchTime || null;
      const base = { submittedAt: ref.submittedAt || null, startedAt, endedAt: null, exitCode: null };
      const deadlineMs = startedAt
        ? new Date(startedAt).getTime() + (Number(ref.maxRuntimeSeconds) + overrunGraceSeconds) * 1000
        : null;

      if (status && ["succeeded", "failed", "timeout"].includes(status.state)) {
        return {
          ...base,
          state: status.state === "succeeded" ? "completed" : "failed",
          endedAt: status.updated_at || null,
          exitCode: Number.isFinite(status.exit_code) ? status.exit_code : null,
          syncKey: `status:${status.updated_at || status.state}`,
          message: status.message || (status.state === "timeout" ? "Time limit reached" : undefined),
        };
      }

      if (cancelled) {
        return { ...base, state: "cancelled", endedAt: cancelled.at || null, syncKey: "cancelled" };
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

      if (!instance) {
        // Right after launch the instance may not be visible yet.
        if (now() - new Date(ref.submittedAt || 0).getTime() < 2 * 60 * 1000) {
          return { ...base, state: "queued" };
        }
        throw httpError("Execution not found", 404);
      }

      if (instance.state === "pending") {
        return { ...base, state: "queued" };
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

    async getLogs(ref, cursor = 0) {
      const cfg = await getConfig();
      const text = (await readText(cfg.bucket, `${prefix(ref)}/logs/job.log`)) ?? "";
      const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
      const offset = Number.isFinite(cursor) && cursor >= 0 ? cursor : 0;
      return { lines: lines.slice(offset), nextCursor: Math.max(offset, lines.length) };
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
