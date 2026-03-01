import createExecutionAdapter from "../execution/createExecutionAdapter.js";

const adapter = createExecutionAdapter();

export async function submitExecution(jobSpec) {
  return adapter.start(jobSpec);
}

export async function getExecutionStatus(executionRef) {
  return adapter.getStatus(executionRef);
}

export async function getExecutionLogs(executionRef, cursor = 0) {
  return adapter.getLogs(executionRef, cursor);
}

export async function getExecutionOutputFiles(executionRef) {
  return adapter.listOutputFiles(executionRef);
}

export async function cancelExecution(executionRef) {
  return adapter.cancel(executionRef);
}

export function getExecutionProvider() {
  return adapter.provider;
}

export async function getExecutionDebugSnapshot() {
  if (typeof adapter.getDebugSnapshot === "function") {
    return adapter.getDebugSnapshot();
  }

  return {
    provider: adapter.provider,
    message: "Debug snapshot is not implemented for this provider",
  };
}
