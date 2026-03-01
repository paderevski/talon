import {
  isCancelableJobStatus,
  jobStatusFilters,
  statusLabel,
} from "talon-shared/status";
import FocusScrollRegion from "./FocusScrollRegion";

function formatSubmittedValue(job) {
  const submittedAt = String(job?.executionRef?.submittedAt ?? "").trim();
  if (submittedAt) {
    const submittedMs = new Date(submittedAt).getTime();
    if (Number.isFinite(submittedMs)) {
      const ageMs = Date.now() - submittedMs;
      if (ageMs >= 0 && ageMs < 24 * 60 * 60 * 1000) {
        const ageMinutes = Math.floor(ageMs / (60 * 1000));
        if (ageMinutes < 1) {
          return "just now";
        }

        if (ageMinutes < 60) {
          return `${ageMinutes}m ago`;
        }

        const ageHours = Math.floor(ageMinutes / 60);
        return `${ageHours}h ago`;
      }

      return new Date(submittedMs).toLocaleString();
    }
  }

  const submittedText = String(job?.submitted ?? "").trim();
  if (submittedText && submittedText.toLowerCase() !== "invalid date") {
    return submittedText;
  }

  return "—";
}

export default function JobStatusPanel({
  jobs,
  activeFilter,
  setActiveFilter,
  statusAvailability,
  onCancelJob,
  onHideJob,
  onUnhideJob,
  jobActionError,
}) {
  const isFilterDisabled = (filter) => {
    if (filter === "running") {
      return !statusAvailability?.hasRunning;
    }

    if (filter === "queued") {
      return !statusAvailability?.hasQueued;
    }

    return false;
  };

  const getFilterTooltip = (filter) => {
    if (filter === "running" && !statusAvailability?.hasRunning) {
      return "No running jobs";
    }

    if (filter === "queued" && !statusAvailability?.hasQueued) {
      return "No queued jobs";
    }

    return undefined;
  };

  return (
    <section className="panel" id="job-status">
      <div className="panel-head">
        <h2 className="panel-title">Job Status</h2>
      </div>
      <div className="table-card job-status-table-card">
        <div className="table-bar">
          {jobStatusFilters.map((filter) => {
            const disabled = isFilterDisabled(filter);
            const tooltip = getFilterTooltip(filter);

            return (
              <span
                key={filter}
                className={`filter-chip-wrap ${tooltip ? "has-tooltip" : ""}`}
                data-tooltip={tooltip || ""}
              >
                <button
                  className={`filter-chip ${activeFilter === filter ? "active" : ""}`}
                  disabled={disabled}
                  onClick={() => setActiveFilter(filter)}
                  type="button"
                >
                  {statusLabel(filter)}
                </button>
              </span>
            );
          })}
        </div>
        <FocusScrollRegion className="job-status-scroll-region" ariaLabel="Job status table">
          <table>
            <thead>
              <tr>
                <th>Job</th>
                <th>Repo</th>
                <th>Status</th>
                <th>GPU</th>
                <th>Submitted</th>
                <th>Duration</th>
                <th>Cost</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td className="job-name-cell">{job.name}</td>
                  <td className="repo-cell">{job.repo}</td>
                  <td>
                    <span className={`status-pill ${job.status}`}>
                      <span className="sdot" />
                      {statusLabel(job.status)}
                    </span>
                  </td>
                  <td className="mono-sm">{job.gpu}</td>
                  <td className="mono-sm">{formatSubmittedValue(job)}</td>
                  <td className="mono-sm">{job.duration}</td>
                  <td className="mono-sm">{String(job?.cost ?? "").trim() || "$0.00"}</td>
                  <td>
                    {isCancelableJobStatus(job.status) ? (
                      <button className="btn btn-secondary btn-sm" type="button" onClick={() => onCancelJob(job.id)}>
                        Cancel
                      </button>
                    ) : null}
                    {job.hidden ? (
                      <button className="btn btn-secondary btn-sm" type="button" onClick={() => onUnhideJob(job.id)}>
                        Unhide
                      </button>
                    ) : (
                      <button className="btn btn-secondary btn-sm" type="button" onClick={() => onHideJob(job.id)}>
                        Hide
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </FocusScrollRegion>
      </div>
      {jobActionError ? <div className="repo-error">{jobActionError}</div> : null}
    </section>
  );
}
