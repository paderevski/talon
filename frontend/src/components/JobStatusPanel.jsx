import {
  isCancelableJobStatus,
  jobStatusFilters,
  statusLabel,
} from "talon-shared/status";
import FocusScrollRegion from "./FocusScrollRegion";

export default function JobStatusPanel({
  jobs,
  activeFilter,
  setActiveFilter,
  statusAvailability,
  executionByJobId,
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
                <th>Execution</th>
                <th>GPU</th>
                <th>Submitted</th>
                <th>Duration</th>
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
                  <td className="mono-sm">{executionByJobId?.[job.id]?.state || "—"}</td>
                  <td className="mono-sm">{job.gpu}</td>
                  <td className="mono-sm">{job.submitted}</td>
                  <td className="mono-sm">{job.duration}</td>
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
