export default function RepoBrowserPanel({ repoData, onRefresh, isRefreshing }) {
  return (
    <section className="panel" id="repo-browser">
      <div className="panel-head">
        <h2 className="panel-title">Repo Browser</h2>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRefresh} disabled={isRefreshing}>
          {isRefreshing ? "Refreshing..." : "Refresh"}
        </button>
      </div>
      <div className="repo-header">
        <span className="repo-path">{repoData.repository}</span>
        <span className="repo-branch">{repoData.branch}</span>
        <span className="repo-meta">{repoData.lastCommit}</span>
      </div>

      <div className="table-card">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Size</th>
              <th>Last Commit Message</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {repoData.items?.length ? (
              repoData.items.map((item) => (
                <tr key={item.name}>
                  <td className="repo-name-cell">{item.name}</td>
                  <td className="mono-sm">{item.size || "—"}</td>
                  <td className="repo-commit-cell">{item.lastCommitMessage || "—"}</td>
                  <td className="mono-sm">{item.updated || "—"}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4} className="repo-empty-cell">No files found</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
