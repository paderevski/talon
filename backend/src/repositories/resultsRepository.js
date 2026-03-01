import { createResultsFileRepository } from "./file/resultsFileRepository.js";

let resultsRepositoryPromise = null;

export function getResultsRepository(
  provider = process.env.RESULTS_REPOSITORY_PROVIDER || "file",
) {
  const normalizedProvider = String(provider).trim().toLowerCase();

  if (normalizedProvider !== "file") {
    throw new Error(
      `Unsupported results repository provider: ${normalizedProvider}`,
    );
  }

  if (!resultsRepositoryPromise) {
    resultsRepositoryPromise = createResultsFileRepository();
  }

  return resultsRepositoryPromise;
}
