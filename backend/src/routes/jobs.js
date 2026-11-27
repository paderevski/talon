import { Router } from "express";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cancelExecution,
  getExecutionLogs,
  getExecutionOutputFiles,
  getExecutionProvider,
  getExecutionStatus,
  ec2JobsEnabled,
  getEc2Adapter,
  openExecutionLog,
  openExecutionOutputFile,
  submitExecution,
} from "../services/jobExecutionService.js";
import { ec2JobLimits, gpuAllowed, launchErrorStatus, startEc2Job } from "../services/ec2Jobs.js";
import { defaultMaxRuntimeSeconds, listInstanceOptions, runtimeOptions } from "../execution/ec2Rates.js";
import { markJobAsExecutionLost, synchronizeJobFromExecution } from "../services/jobSync.js";
import { getJobsRepository } from "../repositories/jobsRepository.js";
import { getSourceType, parseCodeSource, resolveSourceAccess } from "../sources/index.js";
import { normalizeFolder } from "talon-shared/repo";
import { parseScriptArgs } from "../utils/scriptArgs.js";
import { attachAccessScope, canModify, canRunJobs, hasRole, narrowScopeToOwner, scopeAllows } from "../auth/access.js";
import { log } from "../utils/log.js";
import { moreBudgetHint } from "talon-shared/budget";

const router = Router();
router.use(attachAccessScope);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runsRootDir = path.resolve(__dirname, "../../data/runs");

const jobsRepository = await getJobsRepository();

// Cost and limits for new jobs. Local runs are free; once jobs launch on EC2
// instances the rate comes from the instance type's price instead.
function readNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
const jobRateCentsPerHour = () => readNumber("JOB_RATE_CENTS_PER_HOUR", 0);
const jobMaxRuntimeSeconds = () => readNumber("JOB_MAX_RUNTIME_SECONDS", 1800) || 1800;

// Job JSON for clients: the execution reference is trimmed to what the UI
// shows (machine type, instance ID, timestamps); the rest (S3 prefix, launch
// IDs and the like) stays on the server.
function publicJob(job) {
  const ref = job?.executionRef;
  if (!ref) {
    return job;
  }
  const { provider, submittedAt, launchedAt, instanceType, instanceId } = ref;
  return { ...job, executionRef: { provider, submittedAt, launchedAt, instanceType, instanceId } };
}

// Our own errors carry a status and a message meant for the user; anything
// else (an AWS SDK error, say) is logged here and answered generically.
function failWith(res, req, error, fallback, event) {
  if (error?.status) {
    return res.status(error.status).json({ message: error.message || fallback });
  }
  log.error(fallback, { event, requestId: req.id, jobId: req.params?.id, err: error });
  return res.status(500).json({ message: fallback });
}

// Sends a { stream, size } as a download named downloadName. A failure after
// the headers are out can only end the response.
function pipeDownload(req, res, job, file, downloadName, failMessage) {
  res.attachment(downloadName);
  if (Number.isFinite(file.size)) {
    res.setHeader("Content-Length", file.size);
  }
  file.stream.on("error", (error) => {
    log.error("download stream failed", { event: "job.download_failed", requestId: req.id, jobId: job.id, err: error });
    if (res.headersSent) {
      res.destroy(error);
    } else {
      res.removeHeader("Content-Disposition");
      res.removeHeader("Content-Length");
      res.status(500).json({ message: failMessage });
    }
  });
  return file.stream.pipe(res);
}

// Jobs the caller may not see are treated exactly like missing jobs, so
// responses don't reveal that another user's job exists.
async function findVisibleJob(req) {
  const job = await jobsRepository.findById(req.params.id);
  return job && scopeAllows(req.accessScope, job.ownerUsername) ? job : null;
}

async function resolveDownloadFilePath(job, source, relativeName) {
  const executionId = String(job?.executionRef?.executionId || "").trim();
  if (!executionId) {
    const error = new Error("Job execution reference is missing");
    error.status = 400;
    throw error;
  }

  const normalizedSource = String(source || "output_dir")
    .trim()
    .toLowerCase();
  const sourceDirNames =
    normalizedSource === "repo_changed"
      ? ["repo", "output"]
      : ["output", "repo"];

  const normalizedName = String(relativeName || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");

  if (
    !normalizedName ||
    path.isAbsolute(normalizedName) ||
    normalizedName.split("/").includes("..")
  ) {
    const error = new Error("Invalid file name");
    error.status = 400;
    throw error;
  }

  for (const sourceDirName of sourceDirNames) {
    const sourceRootDir = path.resolve(runsRootDir, executionId, sourceDirName);
    const absolutePath = path.resolve(sourceRootDir, normalizedName);
    const insideRootDir =
      absolutePath === sourceRootDir ||
      absolutePath.startsWith(`${sourceRootDir}${path.sep}`);

    if (!insideRootDir) {
      continue;
    }

    try {
      await access(absolutePath, fsConstants.R_OK);
      return {
        absolutePath,
        downloadName: path.basename(normalizedName),
      };
    } catch {
      // Try the alternate source root before failing.
    }
  }

  const error = new Error("File not found");
  error.status = 404;
  throw error;
}

function isTruthyQuery(value) {
  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

router.get("/", async (req, res) => {
  const status = req.query.status;
  const includeHidden = isTruthyQuery(String(req.query.includeHidden ?? ""));
  const jobs = await jobsRepository.list(narrowScopeToOwner(req.accessScope, req.query.owner));

  const itemsWithExecution = await Promise.all(
    jobs.map(async (job) => {
      if (!job.executionRef) {
        return job;
      }

      try {
        return (await synchronizeJobFromExecution(job)).job;
      } catch (error) {
        if (
          error?.status === 404 &&
          (job.status === "running" || job.status === "queued")
        ) {
          return markJobAsExecutionLost(job);
        }

        return job;
      }
    }),
  );

  const visibleItems = includeHidden
    ? itemsWithExecution
    : itemsWithExecution.filter((job) => !job.hidden);

  if (status === "hidden") {
    return res.json({
      items: itemsWithExecution.filter((job) => job.hidden).map(publicJob),
    });
  }

  if (!status || status === "all") {
    return res.json({ items: visibleItems.map(publicJob) });
  }

  return res.json({
    items: visibleItems.filter((job) => job.status === status).map(publicJob),
  });
});

// EC2 jobs can be limited to admins with EC2_JOBS_ADMIN_ONLY=true (kill switch).
const ec2AllowedFor = (user) =>
  ec2JobsEnabled() && (hasRole(user, "admin") || process.env.EC2_JOBS_ADMIN_ONLY !== "true");

// Jobs on the web server itself have no isolation: the script runs as the
// service user, next to the database and the instance role. In production
// nobody may use them (admins included) unless TALON_ALLOW_LOCAL_JOBS=true.
const localJobsAllowedFor = () =>
  process.env.NODE_ENV !== "production" || process.env.TALON_ALLOW_LOCAL_JOBS === "true";

// What the submit form may offer.
router.get("/compute-options", (req, res) => {
  const ec2Enabled = ec2AllowedFor(req.user);
  res.json({
    ec2: {
      enabled: ec2Enabled,
      // GPU machines only for those who may launch them (admins by default).
      options: ec2Enabled ? listInstanceOptions({ includeGpu: gpuAllowed(hasRole(req.user, "admin")) }) : [],
      runtimeSeconds: ec2Enabled ? runtimeOptions() : [],
      defaultRuntimeSeconds: defaultMaxRuntimeSeconds,
      maxJobsPerUser: ec2JobLimits().perUser,
    },
    localAllowed: localJobsAllowedFor(),
  });
});

// The job's code source and the credential to fetch it with (null:
// anonymous, e.g. a public repo), checked before anything is reserved.
// Sends the error response itself and returns undefined when the input is
// bad or the user may not use that source.
async function codeSourceOr4xx(req, res, payload, runner) {
  try {
    const parsed = parseCodeSource(payload);
    const type = getSourceType(parsed.type);
    if (!type.runners.includes(runner)) {
      res.status(400).json({ message: `${type.label} jobs cannot run ${runner === "local" ? "on the web server" : "here"}. Choose a machine.` });
      return undefined;
    }
    return await resolveSourceAccess(req.user.id, parsed);
  } catch (error) {
    res.status(error?.status || 500).json({ message: error?.status ? error.message : "Could not check the code source" });
    return undefined;
  }
}

router.post("/", async (req, res) => {
  if (!canRunJobs(req.user)) {
    return res.status(403).json({ message: "Job running is turned off for your account. Ask your teacher or an admin." });
  }
  const payload = req.body ?? {};
  const folder = normalizeFolder(payload.folder);
  if (folder === null) {
    return res.status(400).json({ message: "Folder must be a plain path inside the repository, like mnist or src/train" });
  }
  const scriptArgsText = String(payload.scriptArgs ?? "").trim();
  let scriptArgs;
  try {
    scriptArgs = parseScriptArgs(scriptArgsText);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }

  if (String(payload.compute ?? "").toLowerCase() === "ec2") {
    if (!ec2AllowedFor(req.user)) {
      return res.status(ec2JobsEnabled() ? 403 : 503).json({
        message: ec2JobsEnabled() ? "Running jobs on EC2 is limited to admins right now" : "EC2 jobs are not enabled on this server",
      });
    }

    const code = await codeSourceOr4xx(req, res, payload, "ec2");
    if (code === undefined) {
      return undefined;
    }

    // Answers once the job is reserved; fetching the code and starting the
    // instance continue in the background (services/ec2Jobs.js), recorded
    // as the job's launch progress.
    try {
      const { job, launch } = await startEc2Job({
        jobsRepository,
        adapter: getEc2Adapter(),
        user: req.user,
        isAdmin: hasRole(req.user, "admin"),
        payload: { ...payload, folder, scriptArgs: scriptArgsText },
        source: code.source,
        credential: code.credential,
      });
      log.info("job submitted", {
        event: "job.submitted",
        requestId: req.id,
        userId: req.user.id,
        jobId: job.id,
        provider: "ec2",
        instanceType: payload.instanceType,
        maxRuntimeSeconds: job.maxRuntimeSeconds,
      });
      launch
        .then((ended) => ended?.executionRef && log.info("job launched", {
          event: "job.launched",
          jobId: job.id,
          instanceType: ended.executionRef.instanceType,
          instanceId: ended.executionRef.instanceId,
        }))
        .catch((error) => log.error("background launch crashed", { event: "job.launch_crashed", jobId: job.id, err: error }));
      return res.status(201).json({ message: "Job submitted; preparing to launch", job: publicJob(job) });
    } catch (error) {
      const status = launchErrorStatus(error) || error?.status || 500;
      (status >= 500 ? log.error : log.info)("job not started", {
        event: "job.launch_failed",
        requestId: req.id,
        userId: req.user.id,
        status,
        ...(status >= 500 ? { err: error } : { error: error?.message }),
        ...(error?.detail ? { detail: error.detail } : {}),
      });
      return res.status(status).json({
        message: status === 402
          ? `Not enough budget left for this job. ${moreBudgetHint(req.user.roles)}`
          : error?.message || "Unable to start the job",
      });
    }
  }

  if (!localJobsAllowedFor()) {
    return res.status(403).json({ message: "Choose a machine to run this job on." });
  }

  // Always the signed-in user; any owner in the body is ignored.
  const hourlyRateCents = jobRateCentsPerHour();

  // Once jobs cost money, a user with no budget left cannot start one
  // (admins too: no account may go below zero).
  if (hourlyRateCents > 0) {
    if ((await jobsRepository.personalBalanceCents(req.user.id)) <= 0) {
      return res.status(402).json({ message: `No budget remaining. ${moreBudgetHint(req.user.roles)}` });
    }
  }

  const code = await codeSourceOr4xx(req, res, payload, "local");
  if (code === undefined) {
    return undefined;
  }

  // The local runner clones git sources in place (it reports changed files
  // with git status). Other sources are fetched straight into its folder,
  // which it then commits so git status still works.
  const isGit = code.source.type === "github";
  const sourceType = getSourceType(code.source.type);
  const spec = {
    name: payload.name || "untitled-job",
    ...(isGit
      ? { repo: code.source.ref.repo, branch: code.source.ref.branch, gitToken: code.credential }
      : { fetchInput: (dir, options) => sourceType.fetchInto(code.source.ref, dir, code.credential, options), sourceLabel: code.source.label }),
    entryScript: payload.entryScript || "train.py",
    folder,
    scriptArgs,
    maxRuntimeSeconds: jobMaxRuntimeSeconds(),
  };

  const executionRef = await submitExecution(spec);
  const savedJob = await jobsRepository.create({
    ownerUserId: req.user.id,
    name: spec.name,
    source: code.source,
    entryScript: spec.entryScript,
    folder: spec.folder,
    scriptArgs: scriptArgsText,
    executionProvider: getExecutionProvider(),
    executionRef,
    hourlyRateCents,
    maxRuntimeSeconds: spec.maxRuntimeSeconds,
  });

  log.info("job submitted", {
    event: "job.submitted",
    requestId: req.id,
    userId: req.user.id,
    jobId: savedJob.id,
    provider: getExecutionProvider(),
    maxRuntimeSeconds: spec.maxRuntimeSeconds,
  });

  return res.status(201).json({
    message: "Job queued",
    job: publicJob(savedJob),
  });
});

router.get("/:id", async (req, res) => {
  const job = await findVisibleJob(req);
  if (!job) {
    return res.json({
      job: null,
      execution: null,
      noData: true,
      message: "No job data available",
    });
  }

  if (!job.executionRef) {
    return res.json({ job: publicJob(job), execution: null });
  }

  try {
    const synchronized = await synchronizeJobFromExecution(job);
    const execution =
      synchronized.execution || (await getExecutionStatus(job.executionRef));

    return res.json({
      job: publicJob(synchronized.job),
      execution,
    });
  } catch (error) {
    if (
      error?.status === 404 &&
      (job.status === "running" || job.status === "queued") &&
      job.executionRef
    ) {
      const lostJob = await markJobAsExecutionLost(job);

      return res.json({
        job: publicJob(lostJob),
        execution: {
          state: "failed",
          submittedAt: job.executionRef.submittedAt || null,
          startedAt: null,
          endedAt: new Date().toISOString(),
          exitCode: 1,
        },
      });
    }

    if (error?.status === 404) {
      return res.json({
        job: publicJob(job),
        execution: null,
        noData: true,
        message: "Execution data is no longer available",
      });
    }

    return failWith(res, req, error, "Unable to load job status", "job.status_failed");
  }
});

router.get("/:id/logs", async (req, res) => {
  const job = await findVisibleJob(req);
  if (!job) {
    return res.json({
      lines: [],
      nextCursor: Number(req.query.cursor ?? 0) || 0,
      noData: true,
      message: "No job data available",
    });
  }

  if (!job.executionRef) {
    return res.json({ lines: [], nextCursor: 0 });
  }

  const cursor = Number(req.query.cursor ?? 0);

  try {
    const logs = await getExecutionLogs(
      job.executionRef,
      Number.isFinite(cursor) ? cursor : 0,
    );
    return res.json(logs);
  } catch (error) {
    if (error?.status === 404) {
      return res.json({
        lines: [],
        nextCursor: Number.isFinite(cursor) ? cursor : 0,
        noData: true,
        message: "Execution logs are no longer available",
      });
    }

    return failWith(res, req, error, "Unable to load job logs", "job.logs_failed");
  }
});

// The whole log as a text file (the logs route above pages it and, for a
// very large EC2 log, skips the middle). Named after the job.
router.get("/:id/logs/download", async (req, res) => {
  const job = await findVisibleJob(req);
  if (!job || !job.executionRef) {
    return res.status(404).json({ message: "Log not found" });
  }
  try {
    const file = await openExecutionLog(job.executionRef);
    const baseName = String(job.name || "job").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "job";
    return pipeDownload(req, res, job, file, `${baseName}.log`, "Unable to download log");
  } catch (error) {
    return failWith(res, req, error, "Unable to download log", "job.log_download_failed");
  }
});

router.get("/:id/files", async (req, res) => {
  const job = await findVisibleJob(req);
  if (!job) {
    return res.json({
      items: [],
      noData: true,
      message: "No job data available",
    });
  }

  if (!job.executionRef) {
    return res.json({ items: [] });
  }

  try {
    const items = await getExecutionOutputFiles(job.executionRef);
    return res.json({ items });
  } catch (error) {
    if (error?.status === 404) {
      return res.json({
        items: [],
        noData: true,
        message: "Execution output files are no longer available",
      });
    }

    return failWith(res, req, error, "Unable to load output files", "job.files_failed");
  }
});

router.get("/:id/files/download", async (req, res) => {
  const job = await findVisibleJob(req);
  if (!job) {
    return res.status(404).json({ message: "Job not found" });
  }

  if (!job.executionRef) {
    return res.status(400).json({ message: "Job has no execution reference" });
  }

  if (job.executionRef.provider === "ec2") {
    try {
      const file = await openExecutionOutputFile(job.executionRef, req.query.name, req.query.source);
      return pipeDownload(req, res, job, file, file.downloadName, "Unable to download file");
    } catch (error) {
      return failWith(res, req, error, "Unable to download file", "job.download_failed");
    }
  }

  try {
    const resolved = await resolveDownloadFilePath(
      job,
      req.query.source,
      req.query.name,
    );

    return res.download(resolved.absolutePath, resolved.downloadName);
  } catch (error) {
    if (!error?.status && error?.code === "ENOENT") {
      return res.status(404).json({ message: "File not found" });
    }
    return failWith(res, req, error, "Unable to download file", "job.download_failed");
  }
});

router.post("/:id/cancel", async (req, res) => {
  const job = await findVisibleJob(req);
  if (!job) {
    return res.status(404).json({ message: "Job not found" });
  }

  if (!canModify(req.user, job.ownerUsername)) {
    return res.status(403).json({ message: "Only the job owner or an admin can cancel it" });
  }

  // A finished job keeps its result: cancelling it would leave a cancel
  // marker that later relabels the stored result.
  if (job.resultSyncKey || ["completed", "failed"].includes(job.status)) {
    return res.status(409).json({ message: "Job has already finished" });
  }

  // An EC2 job still being prepared: finish it here (refunding the
  // reservation). The launcher, on whichever web server, sees it finished
  // and starts nothing; an instance started in a race is terminated by the
  // reconciler (its job is finished).
  if (!job.executionRef && job.executionProvider === "ec2" && !job.resultSyncKey && ["queued", "running"].includes(job.status)) {
    await jobsRepository.finalize(job.id, {
      syncKey: "cancelled-before-launch",
      status: "failed",
      neverRan: true,
      error: "Cancelled before it started",
      finalizedAt: new Date().toISOString(),
    });
    log.info("job cancelled before launch", { event: "job.cancel_requested", requestId: req.id, userId: req.user.id, jobId: job.id, preparing: true });
    return res.json({ ok: true, result: { ok: true, state: "cancelled" } });
  }

  if (!job.executionRef) {
    return res.status(400).json({ message: "Job has no execution reference" });
  }

  try {
    const result = await cancelExecution(job.executionRef);
    log.info("job cancel requested", { event: "job.cancel_requested", requestId: req.id, userId: req.user.id, jobId: job.id });
    return res.json({ ok: true, result });
  } catch (error) {
    return failWith(res, req, error, "Unable to cancel job", "job.cancel_failed");
  }
});

router.delete("/:id", async (req, res) => {
  const currentJob = await findVisibleJob(req);

  if (!currentJob) {
    return res.status(404).json({ message: "Job not found" });
  }

  if (!canModify(req.user, currentJob.ownerUsername)) {
    return res.status(403).json({ message: "Only the job owner or an admin can change it" });
  }

  if (currentJob.hidden) {
    return res.json({
      message: "Job already hidden",
      job: publicJob(currentJob),
    });
  }

  const hiddenJob = await jobsRepository.setHidden(currentJob.id, {
    hidden: true,
    byUserId: req.user.id,
    reason: String(req.body?.reason ?? "").trim() || null,
  });

  return res.json({
    message: "Job hidden from default history",
    job: publicJob(hiddenJob),
  });
});

router.post("/:id/unhide", async (req, res) => {
  const currentJob = await findVisibleJob(req);

  if (!currentJob) {
    return res.status(404).json({ message: "Job not found" });
  }

  if (!canModify(req.user, currentJob.ownerUsername)) {
    return res.status(403).json({ message: "Only the job owner or an admin can change it" });
  }

  if (!currentJob.hidden) {
    return res.json({
      message: "Job already visible",
      job: publicJob(currentJob),
    });
  }

  const visibleJob = await jobsRepository.setHidden(currentJob.id, { hidden: false });

  return res.json({
    message: "Job restored to default history",
    job: publicJob(visibleJob),
  });
});

export default router;
