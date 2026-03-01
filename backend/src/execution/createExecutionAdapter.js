import createLocalExecutionAdapter from "./adapters/localExecutionAdapter.js";
import createKubernetesExecutionAdapter from "./adapters/kubernetesExecutionAdapter.js";

export default function createExecutionAdapter(
  provider = process.env.EXECUTION_PROVIDER || "local",
) {
  const normalizedProvider = String(provider).trim().toLowerCase();

  if (normalizedProvider === "kubernetes") {
    return createKubernetesExecutionAdapter();
  }

  return createLocalExecutionAdapter();
}
