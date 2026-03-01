import {
  isCancelableJobStatus,
  jobStatusFilters,
  statusLabel,
} from "talon-shared/status";

export default function JobStatusPanel({ jobs, activeFilter, setActiveFilter, executionByJobId, onCancelJob, jobActionError }) {
  return (
    <section className="panel" id="job-status">
      <div className="panel-head">
        <h2 className="panel-title">Job Status</h2>
      </div>
      <div className="table-card">
        <div className="table-bar">
          {jobStatusFilters.map((filter) => (
            <button
              key={filter}
              className={`filter-chip ${activeFilter === filter ? "active" : ""}`}
              onClick={() => setActiveFilter(filter)}
              type="button"
            >
              {statusLabel(filter)}
            </button>
          ))}
        </div>
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
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {jobActionError ? <div className="repo-error">{jobActionError}</div> : null}
    </section>
  );
}
