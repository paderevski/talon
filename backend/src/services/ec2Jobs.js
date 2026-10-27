import { BudgetError } from "../budget/ledger.js";
import {
  bootAllowanceSeconds,
  defaultInstanceType,
  hourlyRateCentsFor,
  isKnownInstanceType,
  reservationCentsFor,
} from "../execution/ec2Rates.js";

// Starts a job on its own EC2 instance. Order matters:
//   1. create the job and reserve its maximum cost (one transaction; fails
//      with 402 when the budget does not cover it),
//   2. launch (clone, ship to S3, RunInstances), and save the execution ref,
//   3. if the launch fails, finalize the job as failed, which refunds the
//      whole reservation. Launching is synchronous: no retry or queue yet.
export async function launchEc2Job({ jobsRepository, adapter, user, isAdmin, payload, maxRuntimeSeconds }) {
  const instanceType = String(payload.instanceType || defaultInstanceType);
  if (!isKnownInstanceType(instanceType)) {
    const error = new Error(`Unknown instance type: ${instanceType}`);
    error.status = 400;
    throw error;
  }

  const hourlyRateCents = hourlyRateCentsFor(instanceType);
  const spec = {
    name: payload.name || "untitled-job",
    repo: payload.repo || "unknown/repo",
    branch: payload.branch || "main",
    entryScript: payload.entryScript || "train.py",
    maxRuntimeSeconds,
    instanceType,
    ownerUsername: user.username,
  };

  const job = await jobsRepository.createWithReservation({
    ownerUserId: user.id,
    name: spec.name,
    repo: spec.repo,
    branch: spec.branch,
    entryScript: spec.entryScript,
    executionProvider: "ec2",
    computeType: instanceType,
    hourlyRateCents,
    maxRuntimeSeconds,
    reserveCents: reservationCentsFor(hourlyRateCents, maxRuntimeSeconds),
    enforceBalance: !isAdmin,
  });

  try {
    const executionRef = await adapter.start({ ...spec, jobId: job.id });
    return await jobsRepository.setExecutionRef(job.id, executionRef);
  } catch (error) {
    await jobsRepository.finalize(job.id, {
      syncKey: "launch-failed",
      status: "failed",
      neverRan: true,
      error: `Could not start the job: ${error.message}`,
      finalizedAt: new Date().toISOString(),
    });
    throw error;
  }
}

export function budgetErrorStatus(error) {
  return error instanceof BudgetError ? 402 : null;
}

export { bootAllowanceSeconds };
