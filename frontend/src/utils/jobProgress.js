// The stages of an EC2 job, built only from what the app can observe: the
// job record (status, executionRef) and the "[talon] HH:MM:SS ..." lines that
// infra/ec2/job_boot.sh writes to the job log. Nothing is simulated: a stage
// is done only when its evidence has arrived.

const talonLine = /^\[talon\] (\d\d):(\d\d):(\d\d) (.*)$/;
const dayMs = 24 * 60 * 60 * 1000;

// "[talon] 14:03:05 downloading job input" -> { at, text }. The clock is UTC;
// the date comes from refMs (the launch time), taking the nearest day.
export function parseTalonLine(line, refMs) {
  const match = talonLine.exec(String(line ?? ""));
  if (!match) {
    return null;
  }
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  const ref = new Date(Number.isFinite(refMs) ? refMs : Date.now());
  let at = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate()) + seconds * 1000;
  if (at - ref.getTime() > dayMs / 2) {
    at -= dayMs;
  } else if (ref.getTime() - at > dayMs / 2) {
    at += dayMs;
  }
  return { at, text: match[4] };
}

export function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return "";
  }
  const total = Math.round(ms / 1000);
  if (total < 60) {
    return `${total}s`;
  }
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

// Includes EC2 jobs still being prepared (no execution ref yet).
export function isEc2Job(job) {
  return job?.executionRef?.provider === "ec2" || job?.executionProvider === "ec2";
}

const terminalStatuses = new Set(["completed", "failed", "cancelled"]);

function capitalize(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function setupStepLabel(text) {
  const scratch = /^TALON_SCRATCH_DIR=\S+: ([^,]+), (\S+) free/.exec(text);
  if (scratch) {
    return `Scratch space ready: ${scratch[1]}, ${scratch[2]} free`;
  }
  return capitalize(text);
}

// The packaging step, which depends on where the code came from:
// git: "owner/repo @ branch (abc1234): shallow clone, tar, upload to S3"
// drive: "Colab Notebooks/minimal-rnn: 12 files from Google Drive, tar, upload to S3"
function packagingStep(job, claimed) {
  const source = job?.source || {};
  const ref = source.ref || {};
  // Still being prepared: the launcher's latest step ("Copied 200 of 584 files").
  const live = !claimed && job?.launch?.progress ? job.launch.progress : "";
  if (source.type === "drive") {
    const count = Number(ref.fileCount);
    const files = Number.isFinite(count) && count >= 0 ? `${count} file${count === 1 ? "" : "s"}` : "files";
    return {
      title: "Copy and package the Drive folder",
      detail: claimed
        ? `${source.label || "Google Drive folder"}: ${files} from Google Drive, tar, upload to S3`
        : live || "download from Google Drive, tar, upload to S3",
    };
  }
  const name = source.label || ref.repo || "repository";
  const commit = /^[0-9a-f]{7,}$/.test(ref.commit || "") ? ` (${ref.commit.slice(0, 7)})` : "";
  return {
    title: "Clone and package the repository",
    detail: claimed
      ? `${name}${ref.branch ? ` @ ${ref.branch}` : ""}${commit}: shallow clone, tar, upload to S3`
      : live || "git clone, tar, upload to S3",
  };
}

// job: { status, source: { label, ref: { repo, branch, commit } }, executionRef }; events: parsed [talon] lines
// in order; lastOutput: the latest line the student's code printed.
// Returns { stages, startedAt } where each stage is
// { id, title, where, state: done|active|waiting|failed, detail, startedAt,
//   endedAt, steps: [{ text, at }] }.
export function buildStages({ job, events = [], lastOutput = "" }) {
  const ref = job?.executionRef || {};
  const launchedAt = Date.parse(ref.launchedAt || ref.submittedAt || "") || null;
  const find = (pattern) => events.find((event) => pattern.test(event.text)) || null;
  const first = events[0] || null;
  const runEvent = find(/running the job/);
  const endEvent = find(/^job ended after/);
  // The exit code as text ("0", "124"), undefined when the line has none.
  const endCode = endEvent ? /exit code (\d+)/.exec(endEvent.text)?.[1] : undefined;
  const doneEvent = find(/^done \(/);
  const claimed = Boolean(ref.instanceId);
  const instanceUp = Boolean(first) || job?.status === "running";

  const stages = [
    {
      id: "package",
      ...packagingStep(job, claimed),
      where: "Web server",
      done: claimed,
    },
    {
      id: "claim",
      title: "Claim a machine",
      where: "AWS EC2",
      done: claimed,
      endedAt: launchedAt,
      detail: claimed ? `${ref.instanceType || "instance"} · ${ref.instanceId}` : "RunInstances",
    },
    {
      id: "boot",
      title: "Boot the machine",
      where: "EC2 instance",
      done: Boolean(first),
      startedAt: launchedAt,
      endedAt: first?.at ?? null,
      detail: (() => {
        if (first) {
          const kernel = /([\d.]+)s after kernel boot/.exec(first.text);
          return kernel ? `Linux up in ${Math.round(Number(kernel[1]))}s, boot script started` : "Boot script started";
        }
        return instanceUp
          ? "Linux is starting; waiting for the Talon boot script"
          : "Pending: AWS is placing the instance on a host";
      })(),
    },
    {
      id: "setup",
      title: "Set up the job",
      where: "EC2 instance",
      done: Boolean(runEvent),
      startedAt: first?.at ?? null,
      endedAt: runEvent?.at ?? null,
      steps: first
        ? events.slice(1, runEvent ? events.indexOf(runEvent) : undefined).map((event) => ({ text: setupStepLabel(event.text), at: event.at }))
        : [],
      detail: (() => {
        const took = runEvent && /setup took (\d+)s/.exec(runEvent.text);
        return took ? `Took ${formatElapsed(Number(took[1]) * 1000)} from boot script start` : "Download input, unpack, install tools";
      })(),
    },
    {
      id: "run",
      title: "Run your code",
      where: "EC2 instance",
      done: Boolean(endEvent),
      startedAt: runEvent?.at ?? null,
      endedAt: endEvent?.at ?? null,
      exitCode: endCode === undefined ? null : Number(endCode),
      detail: (() => {
        if (endEvent) {
          if (endCode === undefined) return "Ended";
          return endCode === "0" ? "Exited normally (code 0)" : endCode === "124" ? "Stopped at the time limit" : `Exited with code ${endCode}`;
        }
        return runEvent && lastOutput ? lastOutput : "As the job user, under the time limit";
      })(),
    },
    {
      id: "save",
      title: "Save output to S3",
      where: "EC2 instance → S3",
      done: Boolean(doneEvent),
      startedAt: endEvent?.at ?? null,
      endedAt: doneEvent?.at ?? null,
      steps: endEvent && doneEvent
        ? events.slice(events.indexOf(endEvent) + 1, events.indexOf(doneEvent)).map((event) => ({ text: capitalize(event.text), at: event.at }))
        : [],
      detail: "Output files, changed files and logs",
    },
    {
      id: "finish",
      title: "Shut down",
      where: "EC2 instance",
      done: Boolean(doneEvent),
      startedAt: doneEvent?.at ?? null,
      detail: doneEvent ? "Instance powers off and is terminated; billing stops" : "Power off; the instance is terminated",
    },
  ];

  const terminal = terminalStatuses.has(job?.status);
  // A finished job from before the [talon] step lines existed: nothing to
  // show per stage, but it did complete.
  const noEvidence = terminal && events.length === 0 && job?.status === "completed";
  let activeFound = false;
  const result = stages.map((stage) => {
    let state;
    if (stage.done || noEvidence) {
      state = stage.id === "run" && stage.exitCode ? "failed" : "done";
    } else if (activeFound) {
      state = "waiting";
    } else {
      activeFound = true;
      state = terminal ? "failed" : "active";
    }
    const { done: _done, ...rest } = stage;
    return { steps: [], startedAt: null, endedAt: null, ...rest, state };
  });

  if (terminal && job?.status !== "completed") {
    const failed = result.find((stage) => stage.state === "failed" && !stage.exitCode);
    if (failed) {
      failed.detail = job.status === "cancelled" ? "Cancelled" : job.message || job.error || "Stopped here";
    }
  }

  return { stages: result, startedAt: launchedAt };
}
