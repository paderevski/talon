function notImplemented() {
  const error = new Error(
    "Kubernetes execution adapter is not implemented yet",
  );
  error.status = 501;
  throw error;
}

export default function createKubernetesExecutionAdapter() {
  return {
    provider: "kubernetes",
    async start() {
      notImplemented();
    },
    async getStatus() {
      notImplemented();
    },
    async getLogs() {
      notImplemented();
    },
    async listOutputFiles() {
      notImplemented();
    },
    async cancel() {
      notImplemented();
    },
    async getDebugSnapshot() {
      return {
        provider: "kubernetes",
        message: "Kubernetes execution adapter is not implemented yet",
      };
    },
  };
}
