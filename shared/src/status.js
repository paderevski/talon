export const jobStatusValues = ["queued", "running", "completed", "failed"];

export const jobStatusFilters = [
  "completed",
  "running",
  "queued",
  "failed",
  "hidden",
  "all",
];

export function statusLabel(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return "Unknown";
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export function mapExecutionStateToJobStatus(executionState) {
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

export function isCancelableJobStatus(status) {
  return status === "running" || status === "queued";
}
