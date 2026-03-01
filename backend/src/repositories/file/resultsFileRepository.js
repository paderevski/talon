import {
  initializeResultsStore,
  listResults,
  upsertResultForJob,
} from "../../utils/resultsStore.js";

export async function createResultsFileRepository() {
  await initializeResultsStore();

  return {
    list: () => listResults(),
    upsertForJob: async (resultRecord) => upsertResultForJob(resultRecord),
  };
}
