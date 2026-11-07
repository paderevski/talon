// S3 layout in the jobs bucket (plan: docs/connections-and-sources-plan.md).
// Everything a person owns lives under their user id, never their username
// (usernames can change and be reused), so one prefix covers a storage
// quota, an export, or deleting a graduated student's files:
//
//   users/<userId>/uploads/...   uploaded code or data (planned)
//   users/<userId>/home/...      a persistent home folder (planned)
//   jobs/<jobId>-<launchId>/     one launch: input/ (snapshot, run.sh),
//                                status, logs, outputs (today)
//
// Job folders keep their own prefix and lifecycle (jobs_retention_days).

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function userPrefix(userId) {
  if (!uuidPattern.test(String(userId ?? ""))) {
    throw new Error("A user id is required for a storage path");
  }
  return `users/${String(userId).toLowerCase()}/`;
}

export const userUploadsPrefix = (userId) => `${userPrefix(userId)}uploads/`;
export const userHomePrefix = (userId) => `${userPrefix(userId)}home/`;

// One launch's folder. Job ids can repeat (a new database restarts them), so
// the random launch id keeps folders apart and unguessable.
export function jobLaunchPrefix(jobId, launchId) {
  if (!/^[A-Za-z0-9-]+$/.test(String(jobId ?? "")) || !/^[a-f0-9]{16,64}$/.test(String(launchId ?? ""))) {
    throw new Error("A job id and launch id are required for a job folder");
  }
  return `jobs/${jobId}-${launchId}`;
}

export const jobInputKey = (launchPrefix, name = "repo.tgz") => `${launchPrefix}/input/${name}`;
