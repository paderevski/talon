import { Router } from "express";
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

  if (!status || status === "all") {
    return res.json({ items: itemsWithExecution });
  }

  return res.json({
    items: itemsWithExecution.filter((job) => job.status === status),
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
    gpu: "—",
    submitted: "just now",
    duration: "—",
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
    return res.status(404).json({ message: "Job not found" });
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

    return res.status(error?.status || 500).json({
      message: error?.message || "Unable to load job status",
    });
  }
});

router.get("/:id/logs", async (req, res) => {
  const job = jobsRepository.findById(req.params.id);
  if (!job) {
    return res.status(404).json({ message: "Job not found" });
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
    return res.status(error?.status || 500).json({
      message: error?.message || "Unable to load job logs",
    });
  }
});

router.get("/:id/files", async (req, res) => {
  const job = jobsRepository.findById(req.params.id);
  if (!job) {
    return res.status(404).json({ message: "Job not found" });
  }

  if (!job.executionRef) {
    return res.json({ items: [] });
  }

  try {
    const items = await getExecutionOutputFiles(job.executionRef);
    return res.json({ items });
  } catch (error) {
    return res.status(error?.status || 500).json({
      message: error?.message || "Unable to load output files",
    });
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

export default router;
