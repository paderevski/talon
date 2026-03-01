import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { results as seedResults } from "../data/mockData.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const resultsFilePath = path.resolve(__dirname, "../data/results.json");

let initialized = false;
let resultsCache = [];
let writeChain = Promise.resolve();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeStoredResults(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.items)) {
    return payload.items;
  }

  return [];
}

async function persistResults() {
  const payload = {
    items: resultsCache,
    updatedAt: new Date().toISOString(),
  };

  writeChain = writeChain.then(async () => {
    await mkdir(path.dirname(resultsFilePath), { recursive: true });
    await writeFile(
      resultsFilePath,
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8",
    );
  });

  await writeChain;
}

export async function initializeResultsStore() {
  if (initialized) {
    return;
  }

  try {
    const raw = await readFile(resultsFilePath, "utf8");
    const parsed = JSON.parse(raw);
    resultsCache = normalizeStoredResults(parsed);

    if (!Array.isArray(resultsCache) || resultsCache.length === 0) {
      resultsCache = clone(seedResults);
      await persistResults();
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }

    resultsCache = clone(seedResults);
    await persistResults();
  }

  initialized = true;
}

export function listResults() {
  return resultsCache;
}

export async function setResults(nextResults) {
  resultsCache = Array.isArray(nextResults) ? nextResults : resultsCache;
  await persistResults();
  return resultsCache;
}

export function findResultByJobId(jobId) {
  return resultsCache.find((result) => result?.jobId === jobId);
}

export async function upsertResultForJob(resultRecord) {
  const jobId = String(resultRecord?.jobId ?? "").trim();
  if (!jobId) {
    throw new Error("jobId is required for result upsert");
  }

  const nextRecord = {
    ...resultRecord,
    jobId,
    id: resultRecord?.id || `result-${jobId}`,
  };

  const existingIndex = resultsCache.findIndex(
    (result) => result?.jobId === jobId || result?.id === nextRecord.id,
  );

  if (existingIndex >= 0) {
    resultsCache[existingIndex] = {
      ...resultsCache[existingIndex],
      ...nextRecord,
    };

    if (existingIndex > 0) {
      const [updated] = resultsCache.splice(existingIndex, 1);
      resultsCache.unshift(updated);
    }
  } else {
    resultsCache.unshift(nextRecord);
  }

  await persistResults();
  return nextRecord;
}
