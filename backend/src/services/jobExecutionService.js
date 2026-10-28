import createExecutionAdapter from "../execution/createExecutionAdapter.js";
import createEc2ExecutionAdapter from "../execution/adapters/ec2ExecutionAdapter.js";

// The default adapter runs jobs on the web server (EXECUTION_PROVIDER). The
// EC2 adapter is created on first use and only when EC2_JOBS_ENABLED=true.
// A job's execution ref names its provider, so status, logs, files and cancel
// go to the adapter that started it.
const defaultAdapter = createExecutionAdapter();
let ec2Adapter = null;

export function ec2JobsEnabled() {
  return String(process.env.EC2_JOBS_ENABLED || "").trim().toLowerCase() === "true";
}

export function getEc2Adapter() {
  if (!ec2JobsEnabled()) {
    const error = new Error("EC2 jobs are not enabled on this server");
    error.status = 503;
    throw error;
  }
  ec2Adapter ??= createEc2ExecutionAdapter();
  return ec2Adapter;
}

function adapterFor(executionRef) {
  return executionRef?.provider === "ec2" ? getEc2Adapter() : defaultAdapter;
}

export async function submitExecution(jobSpec) {
  return defaultAdapter.start(jobSpec);
}

export async function getExecutionStatus(executionRef) {
  return adapterFor(executionRef).getStatus(executionRef);
}

export async function getExecutionLogs(executionRef, cursor = 0) {
  return adapterFor(executionRef).getLogs(executionRef, cursor);
}

export async function getExecutionOutputFiles(executionRef) {
  return adapterFor(executionRef).listOutputFiles(executionRef);
}

export async function cancelExecution(executionRef) {
  return adapterFor(executionRef).cancel(executionRef);
}

// EC2 output files are read from S3; local ones are served from disk by the
// route. Returns null for providers that don't stream.
export async function openExecutionOutputFile(executionRef, name, source) {
  const adapter = adapterFor(executionRef);
  return typeof adapter.openOutputFile === "function" ? adapter.openOutputFile(executionRef, name, source) : null;
}

export function getExecutionProvider() {
  return defaultAdapter.provider;
}

export async function getExecutionDebugSnapshot() {
  const local =
    typeof defaultAdapter.getDebugSnapshot === "function"
      ? await defaultAdapter.getDebugSnapshot()
      : { provider: defaultAdapter.provider, message: "Debug snapshot is not implemented for this provider" };
  if (!ec2JobsEnabled()) {
    return local;
  }
  try {
    return { ...local, ec2: await getEc2Adapter().getDebugSnapshot() };
  } catch (error) {
    return { ...local, ec2: { error: error.message } };
  }
}
