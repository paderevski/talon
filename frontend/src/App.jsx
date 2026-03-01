import { useEffect, useMemo, useRef, useState } from "react";
import { cancelJob, fetchJobDetails, fetchJobFiles, fetchJobs, fetchRepoTree, fetchResults, hideJob, login, setApiAuthUser, submitJob, unhideJob } from "./api/client";
import NewJobPanel from "./components/NewJobPanel";
import RepoBrowserPanel from "./components/RepoBrowserPanel";
import JobStatusPanel from "./components/JobStatusPanel";
import ResultsPanel from "./components/ResultsPanel";
import GitHubCredentialsPanel from "./components/GitHubCredentialsPanel";
import ExecutionDebugPanel from "./components/ExecutionDebugPanel";
import talonLogo from "../../assets/talon-logo.png";
import { normalizeRepoInput } from "./utils/repo";

const navSections = [
  { id: "job-status", label: "Job Status" },
  { id: "results", label: "Results" },
  { id: "new-job", label: "Submit New Job" },
  { id: "repo-browser", label: "Repo Browser" },
  { id: "github-credentials", label: "GitHub Credentials" },
];

const emptyRepo = { repository: "", branch: "", lastCommit: "", items: [] };
const authStorageKey = "talon.authUser";
const githubSettingsStorageKey = "talon.githubSettings";
const fallbackRepo = "";
const fallbackBranch = "main";

const defaultGithubSettings = {
  githubUsername: "",
};

const autoStatusFilters = new Set(["completed", "queued", "running"]);

function getPreferredStatusFilter(jobItems) {
  const visibleJobs = Array.isArray(jobItems)
    ? jobItems.filter((job) => !job.hidden)
    : [];

  if (visibleJobs.some((job) => job.status === "running")) {
    return "running";
  }

  if (visibleJobs.some((job) => job.status === "queued")) {
    return "queued";
  }

  return "completed";
}

function getStatusAvailability(jobItems) {
  const visibleJobs = Array.isArray(jobItems)
    ? jobItems.filter((job) => !job.hidden)
    : [];

  return {
    hasRunning: visibleJobs.some((job) => job.status === "running"),
    hasQueued: visibleJobs.some((job) => job.status === "queued"),
  };
}

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
    const sanitizedSettings = {
      githubUsername: String(parsed?.githubUsername ?? "").trim(),
    };

    const hasLegacyKeys = Object.prototype.hasOwnProperty.call(parsed || {}, "defaultRepo")
      || Object.prototype.hasOwnProperty.call(parsed || {}, "defaultBranch");

    if (hasLegacyKeys) {
      window.localStorage.setItem(githubSettingsStorageKey, JSON.stringify(sanitizedSettings));
    }

    return sanitizedSettings;
  } catch {
    window.localStorage.removeItem(githubSettingsStorageKey);
    return defaultGithubSettings;
  }
}

export default function App() {
  const showDebugPanel = new URLSearchParams(window.location.search).get("debug") === "1";
  const [authUser, setAuthUser] = useState(getStoredAuthUser);
  const [githubSettings, setGithubSettings] = useState(getStoredGithubSettings);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const [repoPath, setRepoPath] = useState(
    fallbackRepo
  );
  const [repoBranch, setRepoBranch] = useState(fallbackBranch);
  const [repoDirectoryPath, setRepoDirectoryPath] = useState("");
  const [repoData, setRepoData] = useState(emptyRepo);
  const [repoError, setRepoError] = useState("");
  const [jobs, setJobs] = useState([]);
  const [results, setResults] = useState([]);
  const [executionByJobId, setExecutionByJobId] = useState({});
  const [filesByJobId, setFilesByJobId] = useState({});
  const [jobActionError, setJobActionError] = useState("");
  const [activeFilter, setActiveFilter] = useState("completed");
  const [statusAvailability, setStatusAvailability] = useState({
    hasRunning: false,
    hasQueued: false,
  });
  const [isRefreshingRepo, setIsRefreshingRepo] = useState(false);
  const userMenuRef = useRef(null);

  const hasActiveJobs = useMemo(
    () => jobs.some((job) => job.status === "running" || job.status === "queued"),
    [jobs],
  );

  useEffect(() => {
    setApiAuthUser(authUser?.username || "");
  }, [authUser]);

  const hydrateJobRuntime = async (jobList) => {
    if (!jobList.length) {
      setExecutionByJobId({});
      setFilesByJobId({});
      return;
    }

    const detailResults = await Promise.allSettled(
      jobList.map((job) => fetchJobDetails(job.id))
    );
    const fileResults = await Promise.allSettled(
      jobList.map((job) => fetchJobFiles(job.id))
    );

    const nextExecutionByJobId = {};
    const nextFilesByJobId = {};

    jobList.forEach((job, index) => {
      const detailResult = detailResults[index];
      const fileResult = fileResults[index];

      if (detailResult.status === "fulfilled") {
        nextExecutionByJobId[job.id] = detailResult.value.execution || null;
      }

      if (fileResult.status === "fulfilled") {
        nextFilesByJobId[job.id] = fileResult.value.items || [];
      }
    });

    setExecutionByJobId(nextExecutionByJobId);
    setFilesByJobId(nextFilesByJobId);
  };

  const load = async () => {
    const [repoResult, jobsResult, allJobsResult, resultsResult] = await Promise.allSettled([
      fetchRepoTree(repoPath, repoBranch, { path: repoDirectoryPath }),
      fetchJobs(activeFilter),
      fetchJobs("all"),
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
      const items = jobsResult.value.items || [];
      setJobs(items);
      await hydrateJobRuntime(items);
    } else {
      setJobs([]);
      setExecutionByJobId({});
      setFilesByJobId({});
    }

    if (
      allJobsResult.status === "fulfilled" &&
      autoStatusFilters.has(activeFilter)
    ) {
      const allJobs = allJobsResult.value.items || [];
      setStatusAvailability(getStatusAvailability(allJobs));
      const preferredFilter = getPreferredStatusFilter(allJobs);
      if (preferredFilter !== activeFilter) {
        setActiveFilter(preferredFilter);
      }
    } else if (allJobsResult.status === "fulfilled") {
      setStatusAvailability(getStatusAvailability(allJobsResult.value.items || []));
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
  }, [authUser, repoPath, repoBranch, repoDirectoryPath, activeFilter]);

  useEffect(() => {
    if (!authUser) {
      return;
    }

    if (!hasActiveJobs) {
      return;
    }

    const intervalId = window.setInterval(() => {
      pollRuntimeState();
    }, 5000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [authUser, activeFilter, hasActiveJobs]);

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

  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth > 900) {
        setIsMobileNavOpen(false);
      }
    };

    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const refreshJobs = async () => {
    const [jobsData, allJobsData] = await Promise.all([
      fetchJobs(activeFilter),
      fetchJobs("all"),
    ]);
    const items = jobsData.items || [];
    setJobs(items);
    await hydrateJobRuntime(items);

    if (autoStatusFilters.has(activeFilter)) {
      const allJobs = allJobsData.items || [];
      setStatusAvailability(getStatusAvailability(allJobs));
      const preferredFilter = getPreferredStatusFilter(allJobs);
      if (preferredFilter !== activeFilter) {
        setActiveFilter(preferredFilter);
      }
    } else {
      setStatusAvailability(getStatusAvailability(allJobsData.items || []));
    }
  };

  const pollRuntimeState = async () => {

    const [jobsResult, allJobsResult, resultsResult] = await Promise.allSettled([
      fetchJobs(activeFilter),
      fetchJobs("all"),
      fetchResults(),
    ]);

    if (jobsResult.status === "fulfilled") {
      const items = jobsResult.value.items || [];
      setJobs(items);
      await hydrateJobRuntime(items);
    }

    if (
      allJobsResult.status === "fulfilled" &&
      autoStatusFilters.has(activeFilter)
    ) {
      const allJobs = allJobsResult.value.items || [];
      setStatusAvailability(getStatusAvailability(allJobs));
      const preferredFilter = getPreferredStatusFilter(allJobs);
      if (preferredFilter !== activeFilter) {
        setActiveFilter(preferredFilter);
      }
    } else if (allJobsResult.status === "fulfilled") {
      setStatusAvailability(getStatusAvailability(allJobsResult.value.items || []));
    }

    if (resultsResult.status === "fulfilled") {
      setResults(resultsResult.value.items || []);
    }
  };

  const onCancelJob = async (jobId) => {
    setJobActionError("");

    try {
      await cancelJob(jobId);
      await refreshJobs();
    } catch (error) {
      setJobActionError(error?.message || "Unable to cancel job");
    }
  };

  const onHideJob = async (jobId) => {
    setJobActionError("");

    try {
      await hideJob(jobId, "Hidden from Job Status panel");
      await refreshJobs();
    } catch (error) {
      setJobActionError(error?.message || "Unable to hide job");
    }
  };

  const onUnhideJob = async (jobId) => {
    setJobActionError("");

    try {
      await unhideJob(jobId);
      await refreshJobs();
    } catch (error) {
      setJobActionError(error?.message || "Unable to unhide job");
    }
  };

  const onRefreshRepo = async () => {
    setIsRefreshingRepo(true);
    try {
      const repo = await fetchRepoTree(repoPath, repoBranch, {
        force: true,
        path: repoDirectoryPath,
      });
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
      setRepoDirectoryPath("");
    }
    if (form.branch) {
      setRepoBranch(form.branch);
    }
    await refreshJobs();
  };

  const onRepoBranchChange = (nextRepo, nextBranch) => {
    const normalizedRepo = normalizeRepoInput(nextRepo);
    const nextRepoPath = normalizedRepo || "";
    const normalizedBranch = String(nextBranch ?? "").trim() || fallbackBranch;

    setRepoPath((previous) => (previous === nextRepoPath ? previous : nextRepoPath));
    setRepoBranch((previous) => (previous === normalizedBranch ? previous : normalizedBranch));

    if (nextRepoPath !== repoPath || normalizedBranch !== repoBranch) {
      setRepoDirectoryPath("");
    }
  };

  const onNavigateRepoPath = (nextPath) => {
    setRepoDirectoryPath(String(nextPath ?? "").trim());
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
    setIsMobileNavOpen(false);
    setPassword("");
    setAuthError("");
    setRepoData(emptyRepo);
    setRepoError("");
    setRepoDirectoryPath("");
    setJobs([]);
    setResults([]);
    setExecutionByJobId({});
    setFilesByJobId({});
    setJobActionError("");
    setActiveFilter("completed");
  };

  const onSaveGithubSettings = (nextSettings) => {
    const sanitizedSettings = {
      githubUsername: String(nextSettings?.githubUsername ?? "").trim(),
    };

    setGithubSettings(sanitizedSettings);
    window.localStorage.setItem(githubSettingsStorageKey, JSON.stringify(sanitizedSettings));
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
        <div className="topbar-left">
          <button
            type="button"
            className="btn btn-secondary btn-sm mobile-nav-toggle"
            aria-expanded={isMobileNavOpen}
            aria-label="Toggle navigation"
            onClick={() => setIsMobileNavOpen((previous) => !previous)}
          >
            Menu
          </button>
          <div className="topbar-brand">Academies of Loudoun</div>
        </div>
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
        <nav className={`leftnav ${isMobileNavOpen ? "mobile-open" : ""}`}>
          <div className="side-title">
            <img src={talonLogo} alt="Talon" className="side-logo" />
          </div>
          {navSections.map((section) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              className="nav-item"
              onClick={() => setIsMobileNavOpen(false)}
            >
              {section.label}
              {section.id === "job-status" ? <span className="nav-count">{statusCount}</span> : null}
            </a>
          ))}
        </nav>

        <main className="main">
          <JobStatusPanel
            jobs={jobs}
            activeFilter={activeFilter}
            setActiveFilter={setActiveFilter}
            statusAvailability={statusAvailability}
            onCancelJob={onCancelJob}
            onHideJob={onHideJob}
            onUnhideJob={onUnhideJob}
            jobActionError={jobActionError}
          />
          <ResultsPanel results={results} jobs={jobs} filesByJobId={filesByJobId} />
          <NewJobPanel
            onSubmit={onSubmitJob}
            defaultRepo={repoPath}
            defaultBranch={repoBranch}
            githubUsername={githubSettings.githubUsername}
            onRepoBranchChange={onRepoBranchChange}
          />
          <RepoBrowserPanel
            repoData={repoData}
            repoError={repoError}
            onRefresh={onRefreshRepo}
            onNavigatePath={onNavigateRepoPath}
            isRefreshing={isRefreshingRepo}
            canRefresh={Boolean(repoPath)}
          />
          <GitHubCredentialsPanel
            settings={githubSettings}
            onSave={onSaveGithubSettings}
            authUsername={authUser?.username || ""}
          />
          {showDebugPanel ? <ExecutionDebugPanel /> : null}
        </main>
      </div>
    </div>
  );
}
