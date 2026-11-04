import { useState } from "react";
import { disconnectGithub, githubChooseReposUrl, githubConnectUrl } from "../api/client";

// What came back from GitHub (?github=<code> after the callback redirect).
const resultMessages = {
  connected: "GitHub connected.",
  updated: "Repository access updated on GitHub.",
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

// status: { configured, linked, login } from GET /api/github (null while loading).
export default function GitHubPanel({ status, resultMessage = "", onChanged }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const onDisconnect = async () => {
    setBusy(true);
    setMessage("");
    try {
      await disconnectGithub();
      setMessage("GitHub disconnected. The Talon app stays installed on your account until you remove it in GitHub settings.");
      onChanged?.();
    } catch (error) {
      setMessage(error.message || "Unable to disconnect GitHub");
    } finally {
      setBusy(false);
    }
  };

  const shown = message || resultMessage;

  return (
    <section className="panel" id="github">
      <div className="panel-head">
        <h2 className="panel-title">GitHub</h2>
      </div>

      {!status ? <div className="form-hint">Loading...</div> : null}

      {status && !status.configured ? (
        <div className="form-hint">
          GitHub sign-in is not set up on this server. Public repositories still work: paste the repo URL in Submit Job.
        </div>
      ) : null}

      {status?.configured && !status.linked ? (
        <div className="result-card">
          <div className="form-hint">
            Public repositories work without connecting. To run a private repository, connect your GitHub
            account and choose which repositories Talon may read. Talon only gets read access to those.
          </div>
          <div className="form-actions">
            <a className="btn btn-primary" href={githubChooseReposUrl}>Connect GitHub</a>
            <a className="btn btn-secondary" href={githubConnectUrl}>I already installed the app</a>
          </div>
        </div>
      ) : null}

      {status?.configured && status.linked ? (
        <div className="result-card">
          <div className="result-job-name">Connected as {status.login}</div>
          <div className="form-hint">
            Submit Job lists the repositories the Talon app can read. To add or remove one, choose repositories on GitHub.
          </div>
          <div className="form-actions">
            <a className="btn btn-secondary" href={githubChooseReposUrl}>Choose repositories</a>
            <button type="button" className="btn btn-secondary" onClick={onDisconnect} disabled={busy}>
              {busy ? "Disconnecting..." : "Disconnect"}
            </button>
          </div>
        </div>
      ) : null}

      {shown ? <div className="form-hint">{shown}</div> : null}
    </section>
  );
}
