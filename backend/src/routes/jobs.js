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
import { getResultsRepository } from "../repositories/resultsRepository.js";

const router = Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runsRootDir = path.resolve(__dirname, "../../data/runs");

const jobsRepository = await getJobsRepository();
const resultsRepository = await getResultsRepository();

function formatDurationFromExecution(startedAt, endedAt) {
  if (!startedAt || !endedAt) {
    return "—";
  }

  const startedMs = new Date(startedAt).getTime();
  const endedMs = new Date(endedAt).getTime();

  if (
    !Number.isFinite(startedMs) ||
    !Number.isFinite(endedMs) ||
    endedMs <= startedMs
  ) {
    return "—";
  }

  const totalSeconds = Math.max(1, Math.round((endedMs - startedMs) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
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
  const nextJob = {
    ...job,
    status: "failed",
    resultSyncKey:
      job.resultSyncKey || `lost:${job.executionRef?.executionId || "unknown"}`,
  };

  if (!job.resultSyncKey) {
    await resultsRepository.upsertForJob({
      id: `result-${job.id}`,
      jobId: job.id,
      executionId: job.executionRef?.executionId || "",
      name: job.name,
      status: "failed",
      repo: job.repo,
      duration: job.duration || "—",
      output: "Run output files",
      files: [],
      error: "Execution record missing (backend restart or lost worker state)",
      finalizedAt: new Date().toISOString(),
    });
  }

  return nextJob;
}

async function synchronizeJobFromExecution(job) {
  if (!job?.executionRef) {
    return { job, didMutate: false };
  }

  const execution = await getExecutionStatus(job.executionRef);
  const mappedStatus = mapExecutionStateToJobStatus(execution.state);
  const nextDuration = formatDurationFromExecution(
    execution.startedAt,
    execution.endedAt,
  );

  const nextJob = {
    ...job,
    status: mappedStatus,
    duration: nextDuration !== "—" ? nextDuration : job.duration,
  };

  if (isTerminalExecutionState(execution.state)) {
    const resultSyncKey = execution.endedAt || execution.state;
    if (nextJob.resultSyncKey !== resultSyncKey) {
      let files = [];
      try {
        files = await getExecutionOutputFiles(job.executionRef);
      } catch {
        files = [];
      }

      const normalizedFiles = normalizeResultFiles(files);
      const nextResultStatus =
        execution.state === "completed" ? "completed" : "failed";

      await resultsRepository.upsertForJob({
        id: `result-${job.id}`,
        jobId: job.id,
        executionId: job.executionRef?.executionId || "",
        name: job.name,
        status: nextResultStatus,
        repo: job.repo,
        duration: nextJob.duration || "—",
        output: "Run output files",
        files: normalizedFiles,
        error:
          nextResultStatus === "failed"
            ? execution.state === "cancelled"
              ? "Job cancelled"
              : `Execution failed${Number.isFinite(execution.exitCode) ? ` (exit code ${execution.exitCode})` : ""}`
            : undefined,
        finalizedAt: execution.endedAt || null,
      });

      nextJob.resultSyncKey = resultSyncKey;
    }
  }

  const didMutate =
    nextJob.status !== job.status ||
    nextJob.duration !== job.duration ||
    nextJob.resultSyncKey !== job.resultSyncKey;

  return {
    job: nextJob,
    execution,
    didMutate,
  };
}

router.get("/", async (req, res) => {
  const status = req.query.status;
  const includeHidden = isTruthyQuery(String(req.query.includeHidden ?? ""));
  const jobs = jobsRepository.list();

  let didMutateStatus = false;
  const itemsWithExecution = await Promise.all(
    jobs.map(async (job) => {
      if (!job.executionRef) {
        return job;
      }

      try {
        const synchronized = await synchronizeJobFromExecution(job);
        if (synchronized.didMutate) {
          didMutateStatus = true;
        }
        return synchronized.job;
      } catch (error) {
        if (
          error?.status === 404 &&
          (job.status === "running" || job.status === "queued") &&
          job.executionRef
        ) {
          didMutateStatus = true;
          return markJobAsExecutionLost(job);
        }

        return job;
      }
    }),
  );

  if (didMutateStatus) {
    await jobsRepository.setAll(itemsWithExecution);
  }

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

  const executionRef = await submitExecution({
    name: payload.name || "untitled-job",
    repo: payload.repo || "unknown/repo",
    branch: payload.branch || "main",
    entryScript: payload.entryScript || "train.py",
  });

  const newJob = {
    name: payload.name || "untitled-job",
    repo: payload.repo || "unknown/repo",
    status: "queued",
    hidden: false,
    gpu: "—",
    submitted: "just now",
    duration: "—",
    cost: "$0.00",
    executionProvider: getExecutionProvider(),
    executionRef,
  };

  const savedJob = await jobsRepository.prepend(newJob);

  return res.status(201).json({
    message: "Job queued",
    job: savedJob,
  });
});

router.get("/debug/executions", async (_req, res) => {
  const snapshot = await getExecutionDebugSnapshot();
  return res.json(snapshot);
});

router.get("/:id", async (req, res) => {
  const job = jobsRepository.findById(req.params.id);
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

    if (synchronized.didMutate) {
      const updatedJobs = jobsRepository
        .list()
        .map((item) =>
          item.id === synchronized.job.id ? synchronized.job : item,
        );
      await jobsRepository.setAll(updatedJobs);
    }

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
      const updatedJobs = jobsRepository
        .list()
        .map((item) => (item.id === lostJob.id ? lostJob : item));
      await jobsRepository.setAll(updatedJobs);

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
  const job = jobsRepository.findById(req.params.id);
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
  const job = jobsRepository.findById(req.params.id);
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
  const job = jobsRepository.findById(req.params.id);
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
  const job = jobsRepository.findById(req.params.id);
  if (!job) {
    return res.status(404).json({ message: "Job not found" });
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
  const jobs = jobsRepository.list();
  const index = jobs.findIndex((job) => job.id === req.params.id);

  if (index < 0) {
    return res.status(404).json({ message: "Job not found" });
  }

  const currentJob = jobs[index];
  if (currentJob.hidden) {
    return res.json({
      message: "Job already hidden",
      job: currentJob,
    });
  }

  const hiddenBy = String(req.get("x-auth-user") || "").trim() || "unknown";
  const hiddenReason = String(req.body?.reason ?? "").trim() || undefined;
  const hiddenJob = {
    ...currentJob,
    hidden: true,
    hiddenAt: new Date().toISOString(),
    hiddenBy,
    hiddenReason,
  };

  const nextJobs = jobs.map((job) =>
    job.id === hiddenJob.id ? hiddenJob : job,
  );
  await jobsRepository.setAll(nextJobs);

  return res.json({
    message: "Job hidden from default history",
    job: hiddenJob,
  });
});

router.post("/:id/unhide", async (req, res) => {
  const jobs = jobsRepository.list();
  const index = jobs.findIndex((job) => job.id === req.params.id);

  if (index < 0) {
    return res.status(404).json({ message: "Job not found" });
  }

  const currentJob = jobs[index];
  if (!currentJob.hidden) {
    return res.json({
      message: "Job already visible",
      job: currentJob,
    });
  }

  const visibleJob = {
    ...currentJob,
    hidden: false,
    hiddenAt: undefined,
    hiddenBy: undefined,
    hiddenReason: undefined,
  };

  const nextJobs = jobs.map((job) =>
    job.id === visibleJob.id ? visibleJob : job,
  );
  await jobsRepository.setAll(nextJobs);

  return res.json({
    message: "Job restored to default history",
    job: visibleJob,
  });
});

export default router;
