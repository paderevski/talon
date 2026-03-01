import {
  findJobById,
  initializeJobsStore,
  listJobs,
  prependJob,
  setJobs,
} from "../../utils/jobsStore.js";

export async function createJobsFileRepository() {
  await initializeJobsStore();

  return {
    list: () => listJobs(),
    findById: (jobId) => findJobById(jobId),
    prepend: async (job) => prependJob(job),
    setAll: async (jobs) => setJobs(jobs),
  };
}
