import { createJobsPostgresRepository } from "./postgres/jobsPostgresRepository.js";

let jobsRepositoryPromise = null;

// Jobs and their results share one repository (one Postgres transaction
// finalizes a job, stores its result, and charges the budget).
export function getJobsRepository() {
  if (!jobsRepositoryPromise) {
    jobsRepositoryPromise = Promise.resolve(createJobsPostgresRepository());
  }

  return jobsRepositoryPromise;
}
