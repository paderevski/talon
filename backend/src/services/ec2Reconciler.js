import { overrunGraceSeconds } from "../execution/adapters/ec2ExecutionAdapter.js";
import { log as defaultLog } from "../utils/log.js";

// Keeps EC2 jobs honest without anyone watching. Every tick it
//   1. syncs each unfinished EC2 job, which stores the result and settles the
//      cost once the job has ended (it does not wait for someone to load it),
//   2. terminates job instances that should not be running: no job row for
//      them, the job is already finished, or it is past its time limit.
// A finished instance left running keeps billing, so this is not optional.
// One backend runs it today; two would both do the same idempotent work.
export function createEc2Reconciler({ jobsRepository, adapter, sync, markLost, now = () => Date.now(), log = defaultLog }) {
  const isFinal = (job) => job.status === "completed" || job.status === "failed" || Boolean(job.resultSyncKey);

  async function tick() {
    for (const job of await jobsRepository.listUnfinished("ec2")) {
      try {
        await sync(job);
      } catch (error) {
        if (error?.status === 404) {
          await markLost(job);
        } else {
          log.error("reconciler could not sync job", { event: "ec2.reconcile_sync_failed", jobId: job.id, err: error });
        }
      }
    }

    const terminated = [];
    for (const instance of await adapter.listJobInstances()) {
      const job = instance.jobId ? await jobsRepository.findById(instance.jobId) : null;
      let reason = null;
      if (!job) {
        reason = "no job row";
      } else if (isFinal(job)) {
        reason = "job finished";
      } else if (job.maxRuntimeSeconds && instance.launchTime) {
        const deadline = new Date(instance.launchTime).getTime() + (job.maxRuntimeSeconds + overrunGraceSeconds) * 1000;
        if (now() > deadline) {
          reason = "past time limit";
        }
      }

      if (reason) {
        try {
          await adapter.terminateInstance(instance.instanceId);
          terminated.push(instance.instanceId);
          // Alarm "unknown-job-instance" matches event + reason "no job row".
          // A finished job's instance is routine cleanup; the others mean
          // something went wrong.
          (reason === "job finished" ? log.info : log.warn)(`reconciler terminated ${instance.instanceId} (${reason})`, {
            event: "ec2.instance_terminated",
            instanceId: instance.instanceId,
            jobId: instance.jobId || undefined,
            reason,
          });
        } catch (error) {
          log.error("reconciler could not terminate instance", { event: "ec2.terminate_failed", instanceId: instance.instanceId, jobId: instance.jobId || undefined, err: error });
        }
      }
    }
    return { terminated };
  }

  let timer = null;
  let running = false;

  return {
    tick,
    start(intervalMs = 45_000) {
      timer = setInterval(async () => {
        if (running) {
          return;
        }
        running = true;
        try {
          await tick();
        } catch (error) {
          log.error("reconciler tick failed", { event: "ec2.reconcile_failed", err: error });
        } finally {
          running = false;
        }
      }, intervalMs);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
    },
  };
}
