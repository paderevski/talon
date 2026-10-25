// Display strings the API has always returned, derived from stored values.

export function formatDuration(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds === null || totalSeconds < 0) {
    return "—";
  }

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

export function durationSecondsBetween(startedAt, endedAt) {
  if (!startedAt || !endedAt) {
    return null;
  }

  const startedMs = new Date(startedAt).getTime();
  const endedMs = new Date(endedAt).getTime();
  if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs) || endedMs <= startedMs) {
    return null;
  }

  return Math.max(1, Math.round((endedMs - startedMs) / 1000));
}

export function formatCost(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

export function formatSubmitted(createdAt, now = Date.now()) {
  const createdMs = new Date(createdAt).getTime();
  if (!Number.isFinite(createdMs)) {
    return "—";
  }

  const ageSeconds = Math.max(0, Math.round((now - createdMs) / 1000));
  if (ageSeconds < 60) return "just now";
  if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)}m ago`;
  if (ageSeconds < 86400) return `${Math.floor(ageSeconds / 3600)}h ago`;
  return `${Math.floor(ageSeconds / 86400)}d ago`;
}

// What a job costs: EC2 Linux bills per second with a 60-second minimum.
export function computeCostCents(durationSeconds, hourlyRateCents) {
  const rate = Number(hourlyRateCents || 0);
  if (!(rate > 0) || !Number.isFinite(durationSeconds) || durationSeconds === null) {
    return 0;
  }

  return Math.ceil((Math.max(durationSeconds, 60) * rate) / 3600);
}
