import { mapExecutionStateToJobStatus } from "talon-shared/status";
import { getExecutionOutputFiles, getExecutionStatus } from "./jobExecutionService.js";
import { getJobsRepository } from "../repositories/jobsRepository.js";
import { durationSecondsBetween, formatDuration } from "../utils/jobFormat.js";

// Brings a job row in line with what its execution reports: progress while it
// runs, and on the first look after it ends, the stored result and the charge.
// Used when someone loads a job and by the EC2 reconciler.

const jobsRepository = await getJobsRepository();

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

export async function markJobAsExecutionLost(job) {
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

export async function synchronizeJobFromExecution(job) {
  if (!job?.executionRef) {
    return { job };
  }

  const execution = await getExecutionStatus(job.executionRef);
  const mappedStatus = mapExecutionStateToJobStatus(execution.state);
  const durationSeconds = durationSecondsBetween(execution.startedAt, execution.endedAt);

  if (isTerminalExecutionState(execution.state)) {
    const syncKey = execution.syncKey || execution.endedAt || execution.state;
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
            : execution.message ||
              (execution.exitCode === 137
                ? "The script was killed (exit code 137), usually because it ran out of memory. Try a larger instance."
                : `Execution failed${Number.isFinite(execution.exitCode) ? ` (exit code ${execution.exitCode})` : ""}`)
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
