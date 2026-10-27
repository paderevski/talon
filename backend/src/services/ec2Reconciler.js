import { overrunGraceSeconds } from "../execution/adapters/ec2ExecutionAdapter.js";

// Keeps EC2 jobs honest without anyone watching. Every tick it
//   1. syncs each unfinished EC2 job, which stores the result and settles the
//      cost once the job has ended (it does not wait for someone to load it),
//   2. terminates job instances that should not be running: no job row for
//      them, the job is already finished, or it is past its time limit.
// A finished instance left running keeps billing, so this is not optional.
// One backend runs it today; two would both do the same idempotent work.
export function createEc2Reconciler({ jobsRepository, adapter, sync, markLost, now = () => Date.now(), log = console }) {
  const isFinal = (job) => job.status === "completed" || job.status === "failed" || Boolean(job.resultSyncKey);

  async function tick() {
    for (const job of await jobsRepository.listUnfinished("ec2")) {
      try {
        await sync(job);
      } catch (error) {
        if (error?.status === 404) {
          await markLost(job);
        } else {
          log.error(`[ec2-reconciler] sync ${job.id}: ${error.message}`);
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
          log.log(`[ec2-reconciler] terminated ${instance.instanceId} (${reason})`);
        } catch (error) {
          log.error(`[ec2-reconciler] terminate ${instance.instanceId}: ${error.message}`);
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
          log.error(`[ec2-reconciler] ${error.message}`);
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
