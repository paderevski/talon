import { useEffect, useState } from "react";
import { formatElapsed } from "../utils/jobProgress";

const stateLabel = {
  done: "Done",
  active: "In progress",
  waiting: "Waiting",
  failed: "Stopped",
};

function StageIcon({ state }) {
  if (state === "done") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (state === "failed") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  return null;
}

// A live timeline of an EC2 job: where it is now and how long each stage
// took. Stages come from buildStages (utils/jobProgress.js), which marks a
// stage done only when the job record or the job log says so.
export default function JobProgress({ stages, startedAt, live }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) {
      return undefined;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  const last = stages[stages.length - 1];
  const finishedAt = last?.state === "done" ? last.startedAt : null;
  const total = startedAt ? (finishedAt ?? (live ? now : null)) - startedAt : null;
  const active = stages.find((stage) => stage.state === "active");

  return (
    <div className="job-progress" aria-label="Job progress">
      <div className="job-progress-head">
        <span className="job-progress-now">
          {active ? (
            <>
              <span className="job-progress-live-dot" aria-hidden="true" />
              Now: {active.title.toLowerCase()}
            </>
          ) : stages.some((stage) => stage.state === "failed") ? (
            "Stopped"
          ) : (
            "Finished"
          )}
        </span>
        {Number.isFinite(total) && total >= 0 ? (
          <span className="job-progress-total mono-sm">{formatElapsed(total)} since launch</span>
        ) : null}
      </div>
      <ol className="job-progress-list">
        {stages.map((stage) => {
          const end = stage.endedAt ?? (stage.state === "active" ? now : null);
          const duration = stage.startedAt && end ? end - stage.startedAt : null;
          return (
            <li key={stage.id} className={`job-stage ${stage.state}`}>
              <span className="job-stage-node" aria-hidden="true">
                <StageIcon state={stage.state} />
              </span>
              <div className="job-stage-body">
                <div className="job-stage-title-row">
                  <span className="job-stage-title">{stage.title}</span>
                  <span className="job-stage-where">{stage.where}</span>
                  <span className="sr-only">{stateLabel[stage.state]}</span>
                  {Number.isFinite(duration) && duration >= 0 && stage.state !== "waiting" ? (
                    <span className="job-stage-time mono-sm">{formatElapsed(duration)}</span>
                  ) : null}
                </div>
                {stage.state !== "waiting" ? <div className="job-stage-detail">{stage.detail}</div> : null}
                {stage.steps.length ? (
                  <ul className="job-stage-steps">
                    {stage.steps.map((step, index) => (
                      <li key={`${index}-${step.text}`} className={stage.state === "active" && index === stage.steps.length - 1 ? "current" : ""}>
                        <span className="job-step-time mono-sm">
                          +{formatElapsed(step.at - (stage.startedAt ?? step.at))}
                        </span>
                        {step.text}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
