function label(status) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export default function ResultsPanel({ results }) {
  return (
    <section className="panel" id="results">
      <div className="panel-head">
        <h2 className="panel-title">Results</h2>
      </div>
      <div className="results-grid">
        {results.map((result) => (
          <div className="result-card" key={result.id}>
            <div className="result-card-head">
              <div className="result-job-name">{result.name}</div>
              <span className={`status-pill ${result.status}`}>{label(result.status)}</span>
            </div>
            <div className="result-meta">
              <div className="result-meta-row">
                <span className="result-meta-label">Repo</span>
                <span className="result-meta-value">{result.repo}</span>
              </div>
              <div className="result-meta-row">
                <span className="result-meta-label">Duration</span>
                <span className="result-meta-value">{result.duration}</span>
              </div>
              <div className="result-meta-row">
                <span className="result-meta-label">Output</span>
                <span className="result-meta-value">{result.output || result.error || "—"}</span>
              </div>
            </div>
            <div className="result-files">
              {result.files?.map((file) => (
                <div className="result-file-row" key={file.name}>
                  <span className="result-file-name">{file.name}</span>
                  <span className="result-file-size">{file.size}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
