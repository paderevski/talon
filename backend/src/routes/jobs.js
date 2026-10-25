import { Router } from "express";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mapExecutionStateToJobStatus } from "talon-shared/status";
import {
  cancelExecution,
  getExecutionDebugSnapshot,
  getExecutionLogs,
  getExecutionOutputFiles,
  getExecutionProvider,
  getExecutionStatus,
  submitExecution,
} from "../services/jobExecutionService.js";
import { getJobsRepository } from "../repositories/jobsRepository.js";
import { durationSecondsBetween, formatDuration } from "../utils/jobFormat.js";
import { attachAccessScope, canModify, hasRole, narrowScopeToOwner, scopeAllows } from "../auth/access.js";

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

// Jobs the caller may not see are treated exactly like missing jobs, so
// responses don't reveal that another user's job exists.
async function findVisibleJob(req) {
  const job = await jobsRepository.findById(req.params.id);
  return job && scopeAllows(req.accessScope, job.ownerUsername) ? job : null;
}

function isTerminalExecutionState(executionState) {
  return ["completed", "failed", "cancelled"].includes(executionState);
}

function normalizeResultFiles(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.map((item) => ({
    name: String(item?.name ?? "").trim() || "unnamed",
    size: String(item?.size ?? "").trim(),
    source: item?.source || undefined,
  }));
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

async function markJobAsExecutionLost(job) {
  // Already finalized once (result stored): just make sure it shows as failed.
  if (job.resultSyncKey) {
    return jobsRepository.recordProgress(job.id, { status: "failed" });
  }

  return jobsRepository.finalize(job.id, {
    syncKey: `lost:${job.executionRef?.executionId || "unknown"}`,
    status: "failed",
    executionId: job.executionRef?.executionId || "",
    error: "Execution record missing (backend restart or lost worker state)",
    finalizedAt: new Date().toISOString(),
  });
}

async function synchronizeJobFromExecution(job) {
  if (!job?.executionRef) {
    return { job };
  }

  const execution = await getExecutionStatus(job.executionRef);
  const mappedStatus = mapExecutionStateToJobStatus(execution.state);
  const durationSeconds = durationSecondsBetween(execution.startedAt, execution.endedAt);

  if (isTerminalExecutionState(execution.state)) {
    const syncKey = execution.endedAt || execution.state;
    if (job.resultSyncKey === syncKey) {
      return { job, execution };
    }

    let files = [];
    try {
      files = await getExecutionOutputFiles(job.executionRef);
    } catch {
      files = [];
    }

    const status = execution.state === "completed" ? "completed" : "failed";
    const finalized = await jobsRepository.finalize(job.id, {
      syncKey,
      status,
      durationSeconds,
      executionId: job.executionRef.executionId || "",
      files: normalizeResultFiles(files),
      error:
        status === "failed"
          ? execution.state === "cancelled"
            ? "Job cancelled"
            : `Execution failed${Number.isFinite(execution.exitCode) ? ` (exit code ${execution.exitCode})` : ""}`
          : null,
      finalizedAt: execution.endedAt || null,
    });
    return { job: finalized, execution };
  }

  if (mappedStatus !== job.status || (durationSeconds !== null && formatDuration(durationSeconds) !== job.duration)) {
    return {
      job: await jobsRepository.recordProgress(job.id, { status: mappedStatus, durationSeconds }),
      execution,
    };
  }

  return { job, execution };
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
      items: itemsWithExecution.filter((job) => job.hidden),
    });
  }

  if (!status || status === "all") {
    return res.json({ items: visibleItems });
  }

  return res.json({
    items: visibleItems.filter((job) => job.status === status),
  });
});

router.post("/", async (req, res) => {
  const payload = req.body ?? {};
  // Always the signed-in user; any owner in the body is ignored.
  const hourlyRateCents = jobRateCentsPerHour();

  // Once jobs cost money, a user with no budget left cannot start one.
  if (hourlyRateCents > 0 && !hasRole(req.user, "admin")) {
    if ((await jobsRepository.personalBalanceCents(req.user.id)) <= 0) {
      return res.status(402).json({ message: "No budget remaining. Ask your teacher for more." });
    }
  }

  const spec = {
    name: payload.name || "untitled-job",
    repo: payload.repo || "unknown/repo",
    branch: payload.branch || "main",
    entryScript: payload.entryScript || "train.py",
    maxRuntimeSeconds: jobMaxRuntimeSeconds(),
  };

  const executionRef = await submitExecution(spec);
  const savedJob = await jobsRepository.create({
    ownerUserId: req.user.id,
    name: spec.name,
    repo: spec.repo,
    branch: spec.branch,
    entryScript: spec.entryScript,
    executionProvider: getExecutionProvider(),
    executionRef,
    hourlyRateCents,
    maxRuntimeSeconds: spec.maxRuntimeSeconds,
  });

  return res.status(201).json({
    message: "Job queued",
    job: savedJob,
  });
});

router.get("/debug/executions", async (req, res) => {
  if (!hasRole(req.user, "admin")) {
    return res.status(403).json({ message: "Requires role: admin" });
  }

  const snapshot = await getExecutionDebugSnapshot();
  return res.json(snapshot);
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
    return res.json({ job, execution: null });
  }

  try {
    const synchronized = await synchronizeJobFromExecution(job);
    const execution =
      synchronized.execution || (await getExecutionStatus(job.executionRef));

    return res.json({
      job: synchronized.job,
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
        job: lostJob,
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
        job,
        execution: null,
        noData: true,
        message: "Execution data is no longer available",
      });
    }

    return res.status(error?.status || 500).json({
      message: error?.message || "Unable to load job status",
    });
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

    return res.status(error?.status || 500).json({
      message: error?.message || "Unable to load job logs",
    });
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

    return res.status(error?.status || 500).json({
      message: error?.message || "Unable to load output files",
    });
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

  try {
    const resolved = await resolveDownloadFilePath(
      job,
      req.query.source,
      req.query.name,
    );

    return res.download(resolved.absolutePath, resolved.downloadName);
  } catch (error) {
    const message = error?.message || "Unable to download file";
    const lowerMessage = message.toLowerCase();
    const status =
      error?.status ||
      (lowerMessage.includes("enoent") || lowerMessage.includes("not found")
        ? 404
        : 500);

    return res.status(status).json({ message });
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

  if (!job.executionRef) {
    return res.status(400).json({ message: "Job has no execution reference" });
  }

  try {
    const result = await cancelExecution(job.executionRef);
    return res.json({ ok: true, result });
  } catch (error) {
    return res.status(error?.status || 500).json({
      message: error?.message || "Unable to cancel job",
    });
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
      job: currentJob,
    });
  }

  const hiddenJob = await jobsRepository.setHidden(currentJob.id, {
    hidden: true,
    byUserId: req.user.id,
    reason: String(req.body?.reason ?? "").trim() || null,
  });

  return res.json({
    message: "Job hidden from default history",
    job: hiddenJob,
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
      job: currentJob,
    });
  }

  const visibleJob = await jobsRepository.setHidden(currentJob.id, { hidden: false });

  return res.json({
    message: "Job restored to default history",
    job: visibleJob,
  });
});

export default router;
