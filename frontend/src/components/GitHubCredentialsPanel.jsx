import { useEffect, useState } from "react";
import { fetchGithubPublicRepos } from "../api/client";
import { normalizeRepoInput } from "../utils/repo";

const emptyMessage = "";

export default function GitHubCredentialsPanel({ settings, onSave }) {
  const [githubUsername, setGithubUsername] = useState(settings.githubUsername || "");
  const [defaultRepo, setDefaultRepo] = useState(settings.defaultRepo || "");
  const [defaultBranch, setDefaultBranch] = useState(settings.defaultBranch || "main");
  const [message, setMessage] = useState(emptyMessage);
  const [repoOptions, setRepoOptions] = useState([]);
  const [isLoadingRepos, setIsLoadingRepos] = useState(false);
  const [repoError, setRepoError] = useState("");

  useEffect(() => {
    setGithubUsername(settings.githubUsername || "");
    setDefaultRepo(settings.defaultRepo || "");
    setDefaultBranch(settings.defaultBranch || "main");
  }, [settings]);

  useEffect(() => {
    const trimmedUsername = githubUsername.trim();
    if (!trimmedUsername) {
      setRepoOptions([]);
      setRepoError("");
      setIsLoadingRepos(false);
      return;
    }

    let cancelled = false;
    setIsLoadingRepos(true);
    setRepoError("");

    fetchGithubPublicRepos(trimmedUsername)
      .then((repos) => {
        if (cancelled) {
          return;
        }

        setRepoOptions(repos);

        if (!repos.length) {
          return;
        }

        setDefaultRepo((previous) => {
          const normalizedCurrent = normalizeRepoInput(previous);
          if (!normalizedCurrent || !repos.includes(normalizedCurrent)) {
            return repos[0];
          }
          return previous;
        });
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        setRepoOptions([]);
        setRepoError(error.message || "Unable to load public repositories");
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingRepos(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [githubUsername]);

  const onSubmit = (event) => {
    event.preventDefault();
    setMessage(emptyMessage);

    const payload = {
      githubUsername: githubUsername.trim(),
      defaultRepo: normalizeRepoInput(defaultRepo.trim()) || "jane_smith/bert-nlp",
      defaultBranch: defaultBranch.trim() || "main",
    };

    onSave(payload);
    setMessage("Saved in this browser.");
  };

  return (
    <section className="panel" id="github-credentials">
      <div className="panel-head">
        <h2 className="panel-title">GitHub Credentials</h2>
      </div>

      <form className="new-job-grid" onSubmit={onSubmit}>
        <div className="form-group">
          <label className="form-label" htmlFor="github-username">GitHub Username (optional)</label>
          <input
            id="github-username"
            className="form-input"
            value={githubUsername}
            onChange={(event) => setGithubUsername(event.target.value)}
            placeholder="e.g. octocat"
          />
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="github-default-branch">Default Branch</label>
          <input
            id="github-default-branch"
            className="form-input"
            value={defaultBranch}
            onChange={(event) => setDefaultBranch(event.target.value)}
            placeholder="main"
          />
        </div>

        <div className="form-group full">
          <label className="form-label" htmlFor="github-default-repo">Default Repository</label>
          {githubUsername.trim() ? (
            <select
              id="github-default-repo"
              className="form-select"
              value={
                repoOptions.includes(normalizeRepoInput(defaultRepo))
                  ? normalizeRepoInput(defaultRepo)
                  : (repoOptions[0] || "")
              }
              onChange={(event) => setDefaultRepo(event.target.value)}
              disabled={isLoadingRepos || !repoOptions.length}
            >
              {isLoadingRepos ? <option>Loading repositories...</option> : null}
              {!isLoadingRepos && !repoOptions.length ? <option>No public repositories found</option> : null}
              {repoOptions.map((repo) => (
                <option key={repo} value={repo}>{repo}</option>
              ))}
            </select>
          ) : (
            <input
              id="github-default-repo"
              className="form-input"
              value={defaultRepo}
              onChange={(event) => setDefaultRepo(event.target.value)}
              placeholder="https://github.com/owner/repo"
            />
          )}
          {repoError ? (
            <span className="form-hint">{repoError}. You can still type a repo URL manually by clearing username.</span>
          ) : (
            <span className="form-hint">
              {githubUsername.trim()
                ? "Showing public repositories for this username."
                : "Paste full GitHub URL or use owner/repo. Stored in local browser storage for now."}
            </span>
          )}
        </div>

        <div className="form-group full form-actions">
          <button className="btn btn-primary" type="submit">Save GitHub Settings</button>
          {message ? <span className="form-hint">{message}</span> : null}
        </div>
      </form>
    </section>
  );
}