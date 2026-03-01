import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jobs as seedJobs } from "../data/mockData.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const jobsFilePath = path.resolve(__dirname, "../data/jobs.json");

let initialized = false;
let jobsCache = [];
let writeChain = Promise.resolve();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeStoredJobs(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.items)) {
    return payload.items;
  }

  return [];
}

async function persistJobs() {
  const payload = {
    items: jobsCache,
    updatedAt: new Date().toISOString(),
  };

  writeChain = writeChain.then(async () => {
    await mkdir(path.dirname(jobsFilePath), { recursive: true });
    await writeFile(
      jobsFilePath,
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8",
    );
  });

  await writeChain;
}

function nextJobId() {
  let maxId = 0;

  for (const job of jobsCache) {
    const match = /^job-(\d+)$/.exec(String(job?.id ?? ""));
    if (!match) {
      continue;
    }

    const numericId = Number(match[1]);
    if (Number.isFinite(numericId) && numericId > maxId) {
      maxId = numericId;
    }
  }

  return `job-${maxId + 1}`;
}

export async function initializeJobsStore() {
  if (initialized) {
    return;
  }

  try {
    const raw = await readFile(jobsFilePath, "utf8");
    const parsed = JSON.parse(raw);
    jobsCache = normalizeStoredJobs(parsed);

    if (!Array.isArray(jobsCache) || jobsCache.length === 0) {
      jobsCache = clone(seedJobs);
      await persistJobs();
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }

    jobsCache = clone(seedJobs);
    await persistJobs();
  }

  initialized = true;
}

export function listJobs() {
  return jobsCache;
}

export function findJobById(jobId) {
  return jobsCache.find((job) => job.id === jobId);
}

export async function setJobs(nextJobs) {
  jobsCache = Array.isArray(nextJobs) ? nextJobs : jobsCache;
  await persistJobs();
  return jobsCache;
}

export async function prependJob(job) {
  const nextJob = {
    ...job,
    id: job?.id || nextJobId(),
  };

  jobsCache.unshift(nextJob);
  await persistJobs();
  return nextJob;
}
