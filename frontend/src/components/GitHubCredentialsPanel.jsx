import { useEffect, useState } from "react";
import { deleteGithubToken, fetchGithubPublicRepos, getGithubTokenStatus, saveGithubToken } from "../api/client";
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
  const [tokenInput, setTokenInput] = useState("");
  const [tokenStatus, setTokenStatus] = useState({ hasToken: false, tokenLast4: "", updatedAt: null });
  const [tokenMessage, setTokenMessage] = useState("");
  const [isSavingToken, setIsSavingToken] = useState(false);
  const [isDeletingToken, setIsDeletingToken] = useState(false);
  const canUseRepoDropdown = githubUsername.trim() && !repoError;

  useEffect(() => {
    setGithubUsername(settings.githubUsername || "");
    setDefaultRepo(settings.defaultRepo || "");
    setDefaultBranch(settings.defaultBranch || "main");
  }, [settings]);

  useEffect(() => {
    let cancelled = false;

    getGithubTokenStatus()
      .then((status) => {
        if (cancelled) {
          return;
        }
        setTokenStatus({
          hasToken: Boolean(status?.hasToken),
          tokenLast4: String(status?.tokenLast4 ?? ""),
          updatedAt: status?.updatedAt || null,
        });
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setTokenStatus({ hasToken: false, tokenLast4: "", updatedAt: null });
      });

    return () => {
      cancelled = true;
    };
  }, []);

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
  }, [githubUsername, tokenStatus.updatedAt]);

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

  const onSaveToken = async (event) => {
    event.preventDefault();
    setTokenMessage("");

    const token = tokenInput.trim();
    if (!token) {
      setTokenMessage("Enter a GitHub PAT first.");
      return;
    }

    setIsSavingToken(true);
    try {
      const response = await saveGithubToken(token);
      setTokenStatus({
        hasToken: Boolean(response?.status?.hasToken),
        tokenLast4: String(response?.status?.tokenLast4 ?? ""),
        updatedAt: response?.status?.updatedAt || null,
      });
      setTokenInput("");
      setTokenMessage("Token saved securely on backend.");
    } catch (error) {
      setTokenMessage(error.message || "Unable to save token");
    } finally {
      setIsSavingToken(false);
    }
  };

  const onDeleteToken = async () => {
    setTokenMessage("");
    setIsDeletingToken(true);
    try {
      await deleteGithubToken();
      setTokenStatus({ hasToken: false, tokenLast4: "", updatedAt: null });
      setTokenInput("");
      setTokenMessage("Token deleted.");
    } catch (error) {
      setTokenMessage(error.message || "Unable to delete token");
    } finally {
      setIsDeletingToken(false);
    }
  };

  return (
    <section className="panel" id="github-credentials">
      <div className="panel-head">
        <h2 className="panel-title">GitHub Credentials</h2>
      </div>

      <form className="new-job-grid" onSubmit={onSubmit}>
        <div className="form-group full">
          <label className="form-label" htmlFor="github-token">GitHub Personal Access Token (PAT)</label>
          <input
            id="github-token"
            type="password"
            className="form-input"
            value={tokenInput}
            onChange={(event) => setTokenInput(event.target.value)}
            placeholder={tokenStatus.hasToken ? "Enter new token to replace" : "Paste token"}
            autoComplete="off"
          />
          <span className="form-hint">
            {tokenStatus.hasToken
              ? `Token on file${tokenStatus.tokenLast4 ? ` (…${tokenStatus.tokenLast4})` : ""}${tokenStatus.updatedAt ? ` · updated ${new Date(tokenStatus.updatedAt).toLocaleString()}` : ""}.`
              : "No token saved. GitHub API calls use unauthenticated limits."}
          </span>
          <div className="form-actions">
            <button className="btn btn-secondary" type="button" onClick={onSaveToken} disabled={isSavingToken}>
              {isSavingToken ? "Saving Token..." : (tokenStatus.hasToken ? "Replace Token" : "Save Token")}
            </button>
            <button className="btn btn-secondary" type="button" onClick={onDeleteToken} disabled={isDeletingToken || !tokenStatus.hasToken}>
              {isDeletingToken ? "Deleting..." : "Delete Token"}
            </button>
            {tokenMessage ? <span className="form-hint">{tokenMessage}</span> : null}
          </div>
        </div>

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
          {canUseRepoDropdown ? (
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
            <span className="form-hint">{repoError}. Using manual repository input for now.</span>
          ) : (
            <span className="form-hint">
              {canUseRepoDropdown
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