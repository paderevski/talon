import { statusLabel } from "talon-shared/status";
import { getJobFileDownloadUrl } from "../api/client";

function formatOutputFile(file, index) {
  const value = typeof file === "string" ? { name: file, size: "" } : file;
  return {
    key: `${value?.name || "file"}-${index}`,
    name: value?.name || "unnamed",
    size: value?.size || "",
    source: value?.source || "output_dir",
  };
}

export default function ResultsPanel({ results, jobs, filesByJobId }) {
  const visibleJobIds = new Set(
    (jobs || []).map((job) => String(job?.id || "").trim()).filter(Boolean),
  );

  const persistedResults = (results || []).map((result) => ({
    ...result,
    jobId: result?.jobId || undefined,
  }))
    .filter((result) => visibleJobIds.has(String(result?.jobId || "").trim()));

  const persistedJobIds = new Set(
    persistedResults
      .map((result) => String(result?.jobId || "").trim())
      .filter(Boolean),
  );

  const runtimeResults = (jobs || [])
    .filter((job) => !persistedJobIds.has(String(job?.id || "").trim()))
    .map((job) => ({
      id: `runtime-${job.id}`,
      jobId: job.id,
      name: job.name,
      status: job.status,
      repo: job.repo,
      duration: job.duration,
      output: "Run output files",
      files: filesByJobId?.[job.id] || [],
    }));

  const cards = [...runtimeResults, ...persistedResults];

  return (
    <section className="panel" id="results">
      <div className="panel-head">
        <h2 className="panel-title">Results</h2>
      </div>
      <div className="results-grid">
        {cards.map((result) => (
          <div className="result-card" key={result.id}>
            <div className="result-card-head">
              <div className="result-job-name">{result.name}</div>
              <span className={`status-pill result-status-pill ${result.status}`}>{statusLabel(result.status)}</span>
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
              {(result.files || []).length ? (result.files || []).map((file, index) => {
                const normalizedFile = formatOutputFile(file, index);

                return (
                <div className="result-file-row" key={normalizedFile.key}>
                  {result.jobId ? (
                    <a
                      className="result-file-name result-file-link"
                      href={getJobFileDownloadUrl(result.jobId, normalizedFile.name, normalizedFile.source)}
                    >
                      {normalizedFile.name}
                    </a>
                  ) : (
                    <span className="result-file-name">{normalizedFile.name}</span>
                  )}
                  <span className="result-file-size">{normalizedFile.size}</span>
                </div>
                );
              }) : <div className="result-file-row">No output files yet</div>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
