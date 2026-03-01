import FocusScrollRegion from "./FocusScrollRegion";

function getParentPath(currentPath) {
  const normalized = String(currentPath ?? "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");

  if (!normalized) {
    return "";
  }

  const segments = normalized.split("/");
  segments.pop();
  return segments.join("/");
}

export default function RepoBrowserPanel({
  repoData,
  repoError,
  onRefresh,
  onNavigatePath,
  isRefreshing,
  canRefresh = true,
}) {
  const currentPath = String(repoData?.currentPath ?? "").trim();
  const headerPath = currentPath
    ? `${repoData.repository}/${currentPath}`
    : repoData.repository;
  const parentPath = getParentPath(currentPath);

  const items = Array.isArray(repoData.items) ? repoData.items : [];
  const displayItems = currentPath
    ? [
        {
          name: "..",
          type: "parent",
          path: parentPath,
          size: "",
          lastCommitMessage: "",
          updated: "",
        },
        ...items,
      ]
    : items;

  const onRowDoubleClick = (item) => {
    if (typeof onNavigatePath !== "function") {
      return;
    }

    if (item?.type === "dir" || item?.type === "parent") {
      onNavigatePath(item.path || "");
    }
  };

  return (
    <section className="panel" id="repo-browser">
      <div className="panel-head">
        <h2 className="panel-title">Repo Browser</h2>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRefresh} disabled={isRefreshing || !canRefresh}>
          {isRefreshing ? "Refreshing..." : "Refresh"}
        </button>
      </div>
      {!canRefresh ? <div className="form-hint">Select or load a repository first.</div> : null}
      <div className="repo-header">
        <span className="repo-path">{headerPath}</span>
        <span className="repo-branch">{repoData.branch}</span>
        <span className="repo-meta">{repoData.lastCommit}</span>
      </div>

      {repoError ? <div className="repo-error">{repoError}</div> : null}

      <div className="table-card">
        <FocusScrollRegion className="repo-browser-scroll-region" ariaLabel="Repo browser table">
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
              {displayItems.length ? (
                displayItems.map((item) => {
                  const isNavigable = item?.type === "dir" || item?.type === "parent";
                  return (
                    <tr
                      key={`${item.type}:${item.path || item.name}`}
                      onDoubleClick={() => onRowDoubleClick(item)}
                      className={isNavigable ? "repo-row-navigable" : ""}
                    >
                      <td className={`repo-name-cell${isNavigable ? " repo-name-cell-navigable" : ""}`}>{item.name}</td>
                      <td className="mono-sm">{item.size || "—"}</td>
                      <td className="repo-commit-cell">{item.lastCommitMessage || "—"}</td>
                      <td className="mono-sm">{item.updated || "—"}</td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={4} className="repo-empty-cell">No files found</td>
                </tr>
              )}
            </tbody>
          </table>
        </FocusScrollRegion>
      </div>
    </section>
  );
}
