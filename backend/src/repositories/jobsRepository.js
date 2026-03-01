import { createJobsFileRepository } from "./file/jobsFileRepository.js";

let jobsRepositoryPromise = null;

export function getJobsRepository(
  provider = process.env.JOBS_REPOSITORY_PROVIDER || "file",
) {
  const normalizedProvider = String(provider).trim().toLowerCase();

  if (normalizedProvider !== "file") {
    throw new Error(
      `Unsupported jobs repository provider: ${normalizedProvider}`,
    );
  }

  if (!jobsRepositoryPromise) {
    jobsRepositoryPromise = createJobsFileRepository();
  }

  return jobsRepositoryPromise;
}
