import { Router } from "express";
import { jobs } from "../data/mockData.js";
import {
  cancelExecution,
  getExecutionDebugSnapshot,
  getExecutionLogs,
  getExecutionOutputFiles,
  getExecutionProvider,
  getExecutionStatus,
  submitExecution,
} from "../services/jobExecutionService.js";

const router = Router();

function findJobById(jobId) {
  return jobs.find((job) => job.id === jobId);
}

function mapExecutionStateToJobStatus(executionState) {
  if (!executionState) {
    return "queued";
  }

  if (executionState === "running") {
    return "running";
  }

  if (executionState === "completed") {
    return "completed";
  }

  if (executionState === "failed") {
    return "failed";
  }

  if (executionState === "cancelled") {
    return "failed";
  }

  return "queued";
}

router.get("/", async (req, res) => {
  const status = req.query.status;

  const itemsWithExecution = await Promise.all(
    jobs.map(async (job) => {
      if (!job.executionRef) {
        return job;
      }

      try {
        const execution = await getExecutionStatus(job.executionRef);
        return {
          ...job,
          status: mapExecutionStateToJobStatus(execution.state),
        };
      } catch {
        return job;
      }
    }),
  );

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
    id: `job-${jobs.length + 1}`,
    name: payload.name || "untitled-job",
    repo: payload.repo || "unknown/repo",
    status: "queued",
    gpu: "—",
    submitted: "just now",
    duration: "—",
    executionProvider: getExecutionProvider(),
    executionRef,
  };

  jobs.unshift(newJob);

  return res.status(201).json({
    message: "Job queued",
    job: newJob,
  });
});

router.get("/debug/executions", async (_req, res) => {
  const snapshot = await getExecutionDebugSnapshot();
  return res.json(snapshot);
});

router.get("/:id", async (req, res) => {
  const job = findJobById(req.params.id);
  if (!job) {
    return res.status(404).json({ message: "Job not found" });
  }

  if (!job.executionRef) {
    return res.json({ job, execution: null });
  }

  try {
    const execution = await getExecutionStatus(job.executionRef);
    return res.json({
      job: {
        ...job,
        status: mapExecutionStateToJobStatus(execution.state),
      },
      execution,
    });
  } catch (error) {
    return res.status(error?.status || 500).json({
      message: error?.message || "Unable to load job status",
    });
  }
});

router.get("/:id/logs", async (req, res) => {
  const job = findJobById(req.params.id);
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
  const job = findJobById(req.params.id);
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
  const job = findJobById(req.params.id);
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
