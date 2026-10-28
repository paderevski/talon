import createLocalExecutionAdapter from "./adapters/localExecutionAdapter.js";

export default function createExecutionAdapter() {
  return createLocalExecutionAdapter();
}
