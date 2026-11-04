import { useEffect, useState } from "react";
import { disconnectGithub, fetchGithubRepos, githubChooseReposUrl, githubConnectUrl } from "../api/client";

// What came back from GitHub (?github=<code> after the callback redirect).
const resultMessages = {
  connected: "GitHub connected.",
  updated: "Repository access updated.",
  denied: "GitHub sign-in was cancelled.",
  state: "That GitHub sign-in link expired or was not started here. Try again.",
  "in-use": "That GitHub account is already connected to another Talon user.",
  failed: "Could not connect GitHub. Try again in a minute.",
  "signed-out": "Your Talon session ended. Sign in and connect GitHub again.",
  "not-configured": "GitHub sign-in is not set up on this server yet.",
};

export function githubResultMessage(code) {
  return resultMessages[code] || "";
}

// Flow: "Connect GitHub" signs the student in (GitHub shows its account
// picker). Which repositories Talon may read is chosen on GitHub's install
// page, reached from "Choose repositories" here.
// status: { configured, linked, login } from GET /api/github (null while loading).
export default function GitHubPanel({ status, resultMessage = "", onChanged }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [repos, setRepos] = useState(null); // null: loading or not linked
  const [repoError, setRepoError] = useState("");
  const linked = Boolean(status?.configured && status?.linked);

  useEffect(() => {
    let cancelled = false;
    setRepos(null);
    setRepoError("");
    if (!linked) {
      return undefined;
    }
    fetchGithubRepos()
      .then((items) => !cancelled && setRepos(items))
      .catch((error) => !cancelled && setRepoError(error.message || "Could not load repositories"));
    return () => {
      cancelled = true;
    };
  }, [linked, status?.login]);

  const onDisconnect = async () => {
    setBusy(true);
    setMessage("");
    try {
      await disconnectGithub();
      setMessage("GitHub disconnected. To remove the Talon app from your account too, use GitHub Settings > Applications.");
      onChanged?.();
    } catch (error) {
      setMessage(error.message || "Unable to disconnect GitHub");
    } finally {
      setBusy(false);
    }
  };

  const shown = message || resultMessage;

  return (
    <section className="panel github-panel" id="github">
      <div className="panel-head">
        <h2 className="panel-title">GitHub</h2>
      </div>

      {!status ? <p className="github-text">Loading...</p> : null}

      {status && !status.configured ? (
        <p className="github-text">
          GitHub sign-in is not set up on this server. Public repositories still work: paste the repository URL in Submit Job.
        </p>
      ) : null}

      {status?.configured && !status.linked ? (
        <>
          <p className="github-text">
            Public repositories work without this. To run a private repository, connect your GitHub account;
            Talon only gets read access to the repositories you choose.
          </p>
          <a className="btn btn-primary github-btn" href={githubConnectUrl}>Connect GitHub</a>
        </>
      ) : null}

      {linked ? (
        <>
          <div className="github-account">
            <span className="github-text">
              Signed in to GitHub as <strong>{status.login}</strong>
            </span>
            <span className="github-muted" aria-hidden="true">·</span>
            <button type="button" className="github-link-button" onClick={onDisconnect} disabled={busy}>
              {busy ? "Disconnecting..." : "Disconnect"}
            </button>
          </div>

          {repoError ? <p className="github-text github-error">{repoError}</p> : null}
          {!repoError && repos === null ? <p className="github-text github-muted">Loading repositories...</p> : null}

          {repos && repos.length === 0 ? (
            <>
              <p className="github-text">
                Talon can&apos;t read any of your repositories yet. Choose the ones you want to run on GitHub.
              </p>
              <a className="btn btn-primary github-btn" href={githubChooseReposUrl}>Choose repositories on GitHub</a>
            </>
          ) : null}

          {repos && repos.length > 0 ? (
            <>
              <p className="github-text">Talon can read {repos.length === 1 ? "this repository" : `these ${repos.length} repositories`}:</p>
              <ul className="github-repo-list">
                {repos.map((repo) => (
                  <li key={repo.fullName}>
                    <span className="github-repo-name">{repo.fullName}</span>
                    {repo.private ? <span className="github-private">private</span> : null}
                  </li>
                ))}
              </ul>
              <a className="github-link" href={githubChooseReposUrl}>Add or remove repositories on GitHub ↗</a>
            </>
          ) : null}
        </>
      ) : null}

      {shown ? <p className="github-text github-muted github-message">{shown}</p> : null}
    </section>
  );
}
