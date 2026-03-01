import { useEffect, useMemo, useRef, useState } from "react";
import { fetchJobs, fetchRepoTree, fetchResults, login, setApiAuthUser, submitJob } from "./api/client";
import NewJobPanel from "./components/NewJobPanel";
import RepoBrowserPanel from "./components/RepoBrowserPanel";
import JobStatusPanel from "./components/JobStatusPanel";
import ResultsPanel from "./components/ResultsPanel";
import GitHubCredentialsPanel from "./components/GitHubCredentialsPanel";
import talonLogo from "../../assets/talon-logo.png";
import { normalizeRepoInput } from "./utils/repo";

const navSections = [
  { id: "new-job", label: "New Job" },
  { id: "github-credentials", label: "GitHub Credentials" },
  { id: "repo-browser", label: "Repo Browser" },
  { id: "job-status", label: "Job Status" },
  { id: "results", label: "Results" }
];

const emptyRepo = { repository: "", branch: "main", lastCommit: "", items: [] };
const authStorageKey = "talon.authUser";
const githubSettingsStorageKey = "talon.githubSettings";

const defaultGithubSettings = {
  githubUsername: "",
  defaultRepo: "jane_smith/bert-nlp",
  defaultBranch: "main",
};

function getStoredAuthUser() {
  try {
    const rawValue = window.localStorage.getItem(authStorageKey);
    if (!rawValue) {
      return null;
    }

    const parsed = JSON.parse(rawValue);
    if (!parsed || typeof parsed.username !== "string" || !parsed.username.trim()) {
      return null;
    }

    return { username: parsed.username.trim() };
  } catch {
    return null;
  }
}

function getStoredGithubSettings() {
  try {
    const rawValue = window.localStorage.getItem(githubSettingsStorageKey);
    if (!rawValue) {
      return defaultGithubSettings;
    }

    const parsed = JSON.parse(rawValue);
    return {
      githubUsername: String(parsed?.githubUsername ?? "").trim(),
      defaultRepo: String(parsed?.defaultRepo ?? defaultGithubSettings.defaultRepo).trim() || defaultGithubSettings.defaultRepo,
      defaultBranch: String(parsed?.defaultBranch ?? defaultGithubSettings.defaultBranch).trim() || defaultGithubSettings.defaultBranch,
    };
  } catch {
    return defaultGithubSettings;
  }
}

export default function App() {
  const [authUser, setAuthUser] = useState(getStoredAuthUser);
  const [githubSettings, setGithubSettings] = useState(getStoredGithubSettings);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const [repoPath, setRepoPath] = useState(
    normalizeRepoInput(githubSettings.defaultRepo) || defaultGithubSettings.defaultRepo
  );
  const [repoBranch, setRepoBranch] = useState(githubSettings.defaultBranch || defaultGithubSettings.defaultBranch);
  const [repoData, setRepoData] = useState(emptyRepo);
  const [repoError, setRepoError] = useState("");
  const [jobs, setJobs] = useState([]);
  const [results, setResults] = useState([]);
  const [activeFilter, setActiveFilter] = useState("all");
  const [isRefreshingRepo, setIsRefreshingRepo] = useState(false);
  const userMenuRef = useRef(null);

  useEffect(() => {
    setApiAuthUser(authUser?.username || "");
  }, [authUser]);

  const load = async () => {
    const [repoResult, jobsResult, resultsResult] = await Promise.allSettled([
      fetchRepoTree(repoPath, repoBranch),
      fetchJobs(activeFilter),
      fetchResults()
    ]);

    if (repoResult.status === "fulfilled") {
      setRepoData(repoResult.value);
      setRepoError("");
    } else {
      setRepoData(emptyRepo);
      setRepoError(repoResult.reason?.message || "Unable to load repository data");
    }

    if (jobsResult.status === "fulfilled") {
      setJobs(jobsResult.value.items || []);
    } else {
      setJobs([]);
    }

    if (resultsResult.status === "fulfilled") {
      setResults(resultsResult.value.items || []);
    } else {
      setResults([]);
    }
  };

  useEffect(() => {
    if (!authUser) {
      return;
    }

    load();
  }, [authUser, repoPath, repoBranch, activeFilter]);

  useEffect(() => {
    if (!isUserMenuOpen) {
      return;
    }

    const onDocumentMouseDown = (event) => {
      if (!userMenuRef.current?.contains(event.target)) {
        setIsUserMenuOpen(false);
      }
    };

    const onDocumentKeyDown = (event) => {
      if (event.key === "Escape") {
        setIsUserMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", onDocumentMouseDown);
    document.addEventListener("keydown", onDocumentKeyDown);

    return () => {
      document.removeEventListener("mousedown", onDocumentMouseDown);
      document.removeEventListener("keydown", onDocumentKeyDown);
    };
  }, [isUserMenuOpen]);

  const refreshJobs = async () => {
    const jobsData = await fetchJobs(activeFilter);
    setJobs(jobsData.items || []);
  };

  const onRefreshRepo = async () => {
    setIsRefreshingRepo(true);
    try {
      const repo = await fetchRepoTree(repoPath, repoBranch, { force: true });
      setRepoData(repo);
      setRepoError("");
    } catch (error) {
      setRepoData(emptyRepo);
      setRepoError(error?.message || "Unable to load repository data");
    } finally {
      setIsRefreshingRepo(false);
    }
  };

  const onSubmitJob = async (form) => {
    const normalizedRepo = normalizeRepoInput(form.repo);
    const payload = {
      ...form,
      repo: normalizedRepo || form.repo,
    };

    await submitJob(payload);
    if (normalizedRepo && normalizedRepo !== repoPath) {
      setRepoPath(normalizedRepo);
    }
    if (form.branch) {
      setRepoBranch(form.branch);
    }
    await refreshJobs();
  };

  const statusCount = useMemo(() => jobs.length, [jobs]);

  const avatar = useMemo(() => {
    const value = authUser?.username ?? "";
    if (!value) {
      return "--";
    }
    const parts = value.split(/[^A-Za-z0-9]+/).filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    }
    return value.slice(0, 2).toUpperCase();
  }, [authUser]);

  const onLogin = async (event) => {
    event.preventDefault();
    setAuthError("");
    setIsAuthenticating(true);

    try {
      const response = await login(username, password);
      const user = response.user || null;
      setAuthUser(user);
      if (user?.username) {
        window.localStorage.setItem(authStorageKey, JSON.stringify(user));
      }
      setPassword("");
    } catch (error) {
      setAuthError(error.message || "Login failed");
    } finally {
      setIsAuthenticating(false);
    }
  };

  const onLogout = () => {
    setAuthUser(null);
    window.localStorage.removeItem(authStorageKey);
    setIsUserMenuOpen(false);
    setPassword("");
    setAuthError("");
    setRepoData(emptyRepo);
    setRepoError("");
    setJobs([]);
    setResults([]);
    setActiveFilter("all");
  };

  const onSaveGithubSettings = (nextSettings) => {
    setGithubSettings(nextSettings);
    window.localStorage.setItem(githubSettingsStorageKey, JSON.stringify(nextSettings));
    setRepoPath(normalizeRepoInput(nextSettings.defaultRepo) || defaultGithubSettings.defaultRepo);
    setRepoBranch(nextSettings.defaultBranch || defaultGithubSettings.defaultBranch);
  };

  if (!authUser) {
    return (
      <div className="login-shell">
        <div className="login-card">
          <p className="login-kicker">Welcome</p>
          <h1 className="login-title">Sign in to Talon</h1>
          <img src={talonLogo} alt="Talon" className="login-logo" />

          <form className="login-form" onSubmit={onLogin}>
            <label className="form-label" htmlFor="login-username">Username</label>
            <input
              id="login-username"
              className="form-input"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              required
            />

            <label className="form-label" htmlFor="login-password">Password</label>
            <input
              id="login-password"
              type="password"
              className="form-input"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />

            {authError ? <div className="login-error">{authError}</div> : null}

            <button type="submit" className="btn btn-primary login-button" disabled={isAuthenticating}>
              {isAuthenticating ? "Signing in..." : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <nav className="topbar">
        <div className="topbar-brand">Academies of Loudoun</div>
        <div className="topbar-right">
          <div className="server-pill">g4dn.xlarge · us-east-1</div>
          <div className={`user-menu-wrap${isUserMenuOpen ? " menu-open" : ""}`} ref={userMenuRef}>
            <button
              type="button"
              className="user-pill user-pill-button"
              aria-haspopup="menu"
              aria-expanded={isUserMenuOpen}
              onClick={() => setIsUserMenuOpen((previous) => !previous)}
            >
              <div className="user-avatar">{avatar}</div>
              {authUser.username}
            </button>
            <div className="user-menu-hint">Click for account menu</div>
            <div className={`user-menu${isUserMenuOpen ? " open" : ""}`} role="menu">
              <button type="button" className="user-menu-item user-menu-item-disabled" role="menuitem" disabled>
                Settings (coming soon)
              </button>
              <a className="user-menu-item" href="#github-credentials" role="menuitem" onClick={() => setIsUserMenuOpen(false)}>
                GitHub Credentials
              </a>
              <button type="button" className="user-menu-item" role="menuitem" onClick={onLogout}>
                Logout
              </button>
            </div>
          </div>
        </div>
      </nav>

      <div className="layout">
        <nav className="leftnav">
          <div className="side-title">
            <img src={talonLogo} alt="Talon" className="side-logo" />
          </div>
          {navSections.map((section) => (
            <a key={section.id} href={`#${section.id}`} className="nav-item">
              {section.label}
              {section.id === "job-status" ? <span className="nav-count">{statusCount}</span> : null}
            </a>
          ))}
        </nav>

        <main className="main">
          <NewJobPanel
            onSubmit={onSubmitJob}
            defaultRepo={githubSettings.defaultRepo}
            defaultBranch={githubSettings.defaultBranch}
            githubUsername={githubSettings.githubUsername}
          />
          <GitHubCredentialsPanel settings={githubSettings} onSave={onSaveGithubSettings} />
          <RepoBrowserPanel repoData={repoData} repoError={repoError} onRefresh={onRefreshRepo} isRefreshing={isRefreshingRepo} />
          <JobStatusPanel jobs={jobs} activeFilter={activeFilter} setActiveFilter={setActiveFilter} />
          <ResultsPanel results={results} />
        </main>
      </div>
    </div>
  );
}
