import { useEffect, useState } from "react";
import {
  deleteGithubToken,
  getGithubTokenStatus,
  saveGithubCredentialSettings,
  saveGithubToken,
} from "../api/client";

const emptyMessage = "";

export default function GitHubCredentialsPanel({ settings, onSave, authUsername }) {
  const initialHasUsername = Boolean(String(settings.githubUsername ?? "").trim());
  const [githubUsername, setGithubUsername] = useState(settings.githubUsername || "");
  const [message, setMessage] = useState(emptyMessage);
  const [tokenInput, setTokenInput] = useState("");
  const [tokenStatus, setTokenStatus] = useState({ hasToken: false, tokenLast4: "", updatedAt: null });
  const [tokenMessage, setTokenMessage] = useState("");
  const [isSavingToken, setIsSavingToken] = useState(false);
  const [isDeletingToken, setIsDeletingToken] = useState(false);
  const [isExpanded, setIsExpanded] = useState(!initialHasUsername);
  const [hasUserToggled, setHasUserToggled] = useState(false);

  useEffect(() => {
    setGithubUsername(settings.githubUsername || "");

    if (!hasUserToggled) {
      const hasSavedUsername = Boolean(String(settings.githubUsername ?? "").trim());
      setIsExpanded(!hasSavedUsername);
    }
  }, [settings, hasUserToggled]);

  useEffect(() => {
    let cancelled = false;

    if (!authUsername) {
      console.info("[github-credentials][frontend] no auth user yet; skipping token status request");
      setTokenStatus({ hasToken: false, tokenLast4: "", updatedAt: null });
      return undefined;
    }

    console.info(
      `[github-credentials][frontend] loading token status for auth user='${authUsername}'`,
    );

    getGithubTokenStatus(authUsername)
      .then((status) => {
        if (cancelled) {
          return;
        }
        console.info(
          `[github-credentials][frontend] token status received in panel (hasToken=${Boolean(status?.hasToken)})`,
        );
        const backendGithubUsername = String(status?.githubUsername ?? "").trim();
        setGithubUsername(backendGithubUsername);
        onSave({ githubUsername: backendGithubUsername });
        if (!hasUserToggled) {
          const hasSavedCredentials = Boolean(status?.hasToken) || Boolean(backendGithubUsername);
          setIsExpanded(!hasSavedCredentials);
        }
        setTokenStatus({
          hasToken: Boolean(status?.hasToken),
          tokenLast4: String(status?.tokenLast4 ?? ""),
          updatedAt: status?.updatedAt || null,
        });
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        console.error(
          `[github-credentials][frontend] token status request failed: ${error?.message || "unknown error"}`,
        );
        setTokenStatus({ hasToken: false, tokenLast4: "", updatedAt: null });
      });

    return () => {
      cancelled = true;
    };
  }, [authUsername, hasUserToggled]);

  const onToggleExpanded = () => {
    setHasUserToggled(true);
    setIsExpanded((previous) => !previous);
  };

  useEffect(() => {
    const syncWithHash = () => {
      if (window.location.hash === "#github-credentials") {
        setIsExpanded(true);
      }
    };

    syncWithHash();
    window.addEventListener("hashchange", syncWithHash);

    return () => {
      window.removeEventListener("hashchange", syncWithHash);
    };
  }, []);

  const onSubmit = async (event) => {
    event.preventDefault();
    setMessage(emptyMessage);

    const payload = {
      githubUsername: githubUsername.trim(),
    };

    try {
      const response = await saveGithubCredentialSettings(payload.githubUsername, authUsername);
      const savedGithubUsername = String(response?.status?.githubUsername ?? payload.githubUsername).trim();
      setGithubUsername(savedGithubUsername);
      onSave({ githubUsername: savedGithubUsername });
      setMessage("Saved to backend credentials.");
    } catch (error) {
      setMessage(error.message || "Unable to save GitHub settings");
    }
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
      console.info(
        `[github-credentials][frontend] saving token from panel for auth user='${authUsername || "(missing)"}'`,
      );
      const response = await saveGithubToken(token, authUsername);
      const savedGithubUsername = String(response?.status?.githubUsername ?? githubUsername).trim();
      setGithubUsername(savedGithubUsername);
      onSave({ githubUsername: savedGithubUsername });
      setTokenStatus({
        hasToken: Boolean(response?.status?.hasToken),
        tokenLast4: String(response?.status?.tokenLast4 ?? ""),
        updatedAt: response?.status?.updatedAt || null,
      });
      setTokenInput("");
      setTokenMessage("Token saved securely on backend.");
    } catch (error) {
      console.error(
        `[github-credentials][frontend] save token failed: ${error?.message || "unknown error"}`,
      );
      setTokenMessage(error.message || "Unable to save token");
    } finally {
      setIsSavingToken(false);
    }
  };

  const onDeleteToken = async () => {
    setTokenMessage("");
    setIsDeletingToken(true);
    try {
      console.info(
        `[github-credentials][frontend] deleting token from panel for auth user='${authUsername || "(missing)"}'`,
      );
      await deleteGithubToken(authUsername);
      setTokenStatus({ hasToken: false, tokenLast4: "", updatedAt: null });
      setTokenInput("");
      setTokenMessage("Token deleted.");
    } catch (error) {
      console.error(
        `[github-credentials][frontend] delete token failed: ${error?.message || "unknown error"}`,
      );
      setTokenMessage(error.message || "Unable to delete token");
    } finally {
      setIsDeletingToken(false);
    }
  };

  return (
    <section className="panel" id="github-credentials">
      <div className="panel-head">
        <h2 className="panel-title">GitHub Credentials</h2>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onToggleExpanded}>
          {isExpanded ? "Collapse" : "Expand"}
        </button>
      </div>

      {!isExpanded ? (
        <div className="form-hint">
          {tokenStatus.hasToken || githubUsername
            ? `Configured${tokenStatus.hasToken ? " · token saved" : ""}${githubUsername ? ` · username: ${githubUsername}` : ""}`
            : "No credentials configured."}
        </div>
      ) : null}

      {!isExpanded ? null : (

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
          <span className="form-hint">Used to load repository options in Submit Job.</span>
        </div>

        <div className="form-group full form-actions">
          <button className="btn btn-primary" type="submit">Save GitHub Settings</button>
          {message ? <span className="form-hint">{message}</span> : null}
        </div>
      </form>
      )}
    </section>
  );
}