import { useEffect, useState } from "react";
import { fetchExecutionDebugSnapshot } from "../api/client";

export default function ExecutionDebugPanel() {
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await fetchExecutionDebugSnapshot();
      setSnapshot(data);
    } catch (loadError) {
      setError(loadError?.message || "Unable to load execution debug snapshot");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();

    const timerId = window.setInterval(() => {
      load();
    }, 5000);

    return () => {
      window.clearInterval(timerId);
    };
  }, []);

  return (
    <section className="panel" id="debug-executions">
      <div className="panel-head">
        <h2 className="panel-title">Execution Debug</h2>
        <button type="button" className="btn btn-secondary btn-sm" onClick={load} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {error ? <div className="repo-error">{error}</div> : null}

      <div className="table-card">
        <div className="table-bar debug-inline-stats">
          <span>Provider: {snapshot?.provider || "—"}</span>
          <span>Running: {snapshot?.runningCount ?? "—"}</span>
          <span>Queued: {snapshot?.queuedCount ?? "—"}</span>
          <span>Max Concurrent: {snapshot?.maxConcurrentJobs ?? "—"}</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Execution ID</th>
              <th>State</th>
              <th>Repo</th>
              <th>Branch</th>
              <th>Script</th>
            </tr>
          </thead>
          <tbody>
            {(snapshot?.executions || []).length ? (
              snapshot.executions.map((execution) => (
                <tr key={execution.executionId}>
                  <td className="mono-sm">{execution.executionId}</td>
                  <td className="mono-sm">{execution.state}</td>
                  <td className="repo-cell">{execution.repo}</td>
                  <td className="mono-sm">{execution.branch}</td>
                  <td className="mono-sm">{execution.entryScript}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={5} className="repo-empty-cell">No executions yet</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
