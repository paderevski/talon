export default function RepoBrowserPanel({ repoData }) {
  return (
    <section className="panel" id="repo-browser">
      <div className="panel-head">
        <h2 className="panel-title">Repo Browser</h2>
      </div>
      <div className="repo-header">
        <span className="repo-path">{repoData.repository}</span>
        <span className="repo-branch">{repoData.branch}</span>
        <span className="repo-meta">{repoData.lastCommit}</span>
      </div>
      <div className="file-tree">
        {repoData.items?.map((item) => (
          <div className="file-row" key={item.name}>
            <span className="file-name">{item.name}</span>
            <span className="file-size">{item.size || ""}</span>
            <span className="file-modified">{item.modified}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
