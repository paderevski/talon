const filters = ["all", "running", "queued", "completed", "failed"];

function toLabel(status) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export default function JobStatusPanel({ jobs, activeFilter, setActiveFilter }) {
  return (
    <section className="panel" id="job-status">
      <div className="panel-head">
        <h2 className="panel-title">Job Status</h2>
      </div>
      <div className="table-card">
        <div className="table-bar">
          {filters.map((filter) => (
            <button
              key={filter}
              className={`filter-chip ${activeFilter === filter ? "active" : ""}`}
              onClick={() => setActiveFilter(filter)}
              type="button"
            >
              {toLabel(filter)}
            </button>
          ))}
        </div>
        <table>
          <thead>
            <tr>
              <th>Job</th>
              <th>Repo</th>
              <th>Status</th>
              <th>GPU</th>
              <th>Submitted</th>
              <th>Duration</th>
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
                    {toLabel(job.status)}
                  </span>
                </td>
                <td className="mono-sm">{job.gpu}</td>
                <td className="mono-sm">{job.submitted}</td>
                <td className="mono-sm">{job.duration}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
