import { useEffect, useMemo, useRef, useState } from "react";
import { cancelJob, fetchCurrentUser, fetchJobDetails, fetchJobFiles, fetchJobs, fetchRepoTree, fetchResults, hideJob, login, logout, setUnauthorizedHandler, submitJob, unhideJob } from "./api/client";
import NewJobPanel from "./components/NewJobPanel";
import RepoBrowserPanel from "./components/RepoBrowserPanel";
import JobStatusPanel from "./components/JobStatusPanel";
import ResultsPanel from "./components/ResultsPanel";
import GitHubCredentialsPanel from "./components/GitHubCredentialsPanel";
import ExecutionDebugPanel from "./components/ExecutionDebugPanel";
import AdminConsole from "./components/AdminConsole";
import ChangePasswordDialog from "./components/ChangePasswordDialog";
import TeacherStudentsPanel from "./components/TeacherStudentsPanel";
import talonLogo from "../../assets/talon-logo.png";
import { normalizeRepoInput } from "./utils/repo";
import { formatDollars } from "./utils/format";

function getNavSections(role, hasTeacherStudentView) {
  const normalizedRole = normalizeUserRole(role);

  if (normalizedRole === "teacher" && !hasTeacherStudentView) {
    return [{ id: "teacher-students", label: "Students" }];
  }

  // A teacher looking at one student sees their jobs and results only.
  if (normalizedRole === "teacher") {
    return [
      { id: "teacher-student-view", label: "Student" },
      { id: "job-status", label: "Job Status" },
      { id: "results", label: "Results" },
    ];
  }

  if (normalizedRole === "admin") {
    return [
      { id: "admin-roster", label: "Overview" },
      { id: "admin-users", label: "Users" },
      { id: "admin-classes", label: "Classes" },
      { id: "admin-budgets", label: "Budgets" },
    ];
  }

  const sections = [
    { id: "job-status", label: "Job Status" },
    { id: "results", label: "Results" },
    { id: "new-job", label: "Submit New Job" },
    { id: "repo-browser", label: "Repo Browser" },
    { id: "github-credentials", label: "GitHub Credentials" },
  ];

  return sections;
}

const emptyRepo = { repository: "", branch: "", lastCommit: "", items: [] };
const authStorageKey = "talon.authUser";
const githubSettingsStorageKey = "talon.githubSettings";
const fallbackRepo = "";
const fallbackBranch = "main";

const defaultGithubSettings = {
  githubUsername: "",
};
const validUserRoles = new Set(["student", "teacher", "admin"]);

const autoStatusFilters = new Set(["completed", "queued", "running"]);

function normalizeUserRole(role) {
  const normalizedRole = String(role ?? "").trim().toLowerCase();
  return validUserRoles.has(normalizedRole) ? normalizedRole : "student";
}

function getLandingContentForRole(role) {
  const normalizedRole = normalizeUserRole(role);

  if (normalizedRole === "teacher") {
    return {
      kicker: "Teacher Home",
      title: "Review class workloads and unblock student runs",
      description: "Teacher accounts land on a teaching-focused overview with quick access to current experiments, recent outputs, and repo checks.",
      highlights: [
        "Review active and queued jobs across your class projects.",
        "Open the repo browser to verify assignment branches and entry scripts.",
        "Check recent results before sharing feedback with students.",
      ],
      primaryAction: "Open Teaching Workspace",
    };
  }

  if (normalizedRole === "admin") {
    return {
      kicker: "Admin Home",
      title: "Manage users, classes and budgets",
      description: "Admin accounts land on the management screens: who can sign in, which classes exist, and how much each teacher can hand out.",
      highlights: [
        "Add users, change roles, reset passwords and disable accounts.",
        "Create classes and assign teachers and students.",
        "Add money to a teacher's pool or to a personal budget.",
      ],
      primaryAction: "Open Admin Workspace",
    };
  }

  return {
    kicker: "Student Home",
    title: "Launch experiments and track your training progress",
    description: "Student accounts land on a workspace tuned for submitting jobs, watching status changes, and reviewing outputs.",
    highlights: [
      "Submit a new training job from your repository.",
      "Track queued and running work without leaving the page.",
      "Review generated results and output files after completion.",
    ],
    primaryAction: "Open Student Workspace",
  };
}

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

    return {
      username: parsed.username.trim(),
      fullName: String(parsed.fullName ?? "").trim(),
      role: normalizeUserRole(parsed.role),
    };
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
  const [activePage, setActivePage] = useState("landing");
  const [githubSettings, setGithubSettings] = useState(getStoredGithubSettings);
  const [selectedStudentView, setSelectedStudentView] = useState(null);
  const [budgetBalance, setBudgetBalance] = useState(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const [isPasswordDialogOpen, setIsPasswordDialogOpen] = useState(false);
  const [repoPath, setRepoPath] = useState(
    fallbackRepo
  );
  const [repoBranch, setRepoBranch] = useState(fallbackBranch);
  const [repoDirectoryPath, setRepoDirectoryPath] = useState("");
  const [repoData, setRepoData] = useState(emptyRepo);
  const [repoError, setRepoError] = useState("");
  const [jobs, setJobs] = useState([]);
  const [allJobs, setAllJobs] = useState([]);
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
  const onLogoutRef = useRef(null);

  // The server already limits jobs and results to what this user may see
  // (students: their own; teachers: their students'; admins: everyone). A
  // teacher viewing one student additionally asks the server for just that student.
  const viewedOwner = useMemo(
    () => (normalizeUserRole(authUser?.role) === "teacher" ? selectedStudentView?.username || "" : ""),
    [authUser, selectedStudentView],
  );
  const effectiveOwnerUsername = viewedOwner;

  const visibleJobs = jobs;
  const visibleAllJobs = allJobs;
  const visibleResults = results;
  const visibleStatusAvailability = useMemo(
    () => getStatusAvailability(allJobs),
    [allJobs],
  );

  const hasActiveJobs = useMemo(
    () => visibleAllJobs.some((job) => job.status === "running" || job.status === "queued"),
    [visibleAllJobs],
  );

  // The server session is the source of truth; localStorage only avoids a
  // login-screen flash on reload. Confirm (or clear) it on load.
  useEffect(() => {
    let cancelled = false;
    fetchCurrentUser()
      .then((user) => {
        if (cancelled) {
          return;
        }
        if (!user) {
          onLogoutRef.current?.({ skipServer: true });
          return;
        }
        const sessionUser = {
          username: String(user.username ?? "").trim(),
          fullName: String(user.fullName ?? "").trim(),
          role: normalizeUserRole(user.role),
        };
        setAuthUser(sessionUser);
        setBudgetBalance(typeof user.budgetBalance === "number" ? user.budgetBalance : null);
        window.localStorage.setItem(authStorageKey, JSON.stringify(sessionUser));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Any 401 from the API (expired session, server restart) signs out locally.
  useEffect(() => {
    setUnauthorizedHandler(() => onLogoutRef.current?.({ skipServer: true }));
    return () => setUnauthorizedHandler(null);
  }, []);

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
    void refreshBudget();
    const [repoResult, jobsResult, allJobsResult, resultsResult] = await Promise.allSettled([
      fetchRepoTree(repoPath, repoBranch, { path: repoDirectoryPath }),
      fetchJobs(activeFilter, { owner: viewedOwner }),
      fetchJobs("all", { owner: viewedOwner }),
      fetchResults({ owner: viewedOwner })
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
      setAllJobs([]);
      setExecutionByJobId({});
      setFilesByJobId({});
    }

    if (
      allJobsResult.status === "fulfilled" &&
      autoStatusFilters.has(activeFilter)
    ) {
      const allJobs = allJobsResult.value.items || [];
      setAllJobs(allJobs);
      setStatusAvailability(getStatusAvailability(allJobs));
      const preferredFilter = getPreferredStatusFilter(allJobs);
      if (preferredFilter !== activeFilter) {
        setActiveFilter(preferredFilter);
      }
    } else if (allJobsResult.status === "fulfilled") {
      const nextAllJobs = allJobsResult.value.items || [];
      setAllJobs(nextAllJobs);
      setStatusAvailability(getStatusAvailability(nextAllJobs));
    } else {
      setAllJobs([]);
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
  }, [authUser, repoPath, repoBranch, repoDirectoryPath, activeFilter, effectiveOwnerUsername]);

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
      fetchJobs(activeFilter, { owner: viewedOwner }),
      fetchJobs("all", { owner: viewedOwner }),
    ]);
    const items = jobsData.items || [];
    setJobs(items);
    await hydrateJobRuntime(items);
    const nextAllJobs = allJobsData.items || [];
    setAllJobs(nextAllJobs);

    if (autoStatusFilters.has(activeFilter)) {
      setStatusAvailability(getStatusAvailability(nextAllJobs));
      const preferredFilter = getPreferredStatusFilter(nextAllJobs);
      if (preferredFilter !== activeFilter) {
        setActiveFilter(preferredFilter);
      }
    } else {
      setStatusAvailability(getStatusAvailability(nextAllJobs));
    }
  };

  // A student's remaining budget changes when jobs finish; keep the header current.
  const refreshBudget = async () => {
    if (normalizeUserRole(authUser?.role) !== "student") {
      return;
    }
    try {
      const user = await fetchCurrentUser();
      if (user && typeof user.budgetBalance === "number") {
        setBudgetBalance(user.budgetBalance);
      }
    } catch {
      // Header budget is best effort.
    }
  };

  const pollRuntimeState = async () => {
    void refreshBudget();

    const [jobsResult, allJobsResult, resultsResult] = await Promise.allSettled([
      fetchJobs(activeFilter, { owner: viewedOwner }),
      fetchJobs("all", { owner: viewedOwner }),
      fetchResults({ owner: viewedOwner }),
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
      const nextAllJobs = allJobsResult.value.items || [];
      setAllJobs(nextAllJobs);
      setStatusAvailability(getStatusAvailability(nextAllJobs));
      const preferredFilter = getPreferredStatusFilter(nextAllJobs);
      if (preferredFilter !== activeFilter) {
        setActiveFilter(preferredFilter);
      }
    } else if (allJobsResult.status === "fulfilled") {
      const nextAllJobs = allJobsResult.value.items || [];
      setAllJobs(nextAllJobs);
      setStatusAvailability(getStatusAvailability(nextAllJobs));
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
    // The server assigns the job to whoever is signed in.
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

  const statusCount = useMemo(() => visibleJobs.length, [visibleJobs]);

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
  const landingContent = useMemo(
    () => getLandingContentForRole(authUser?.role),
    [authUser],
  );
  const isAdmin = normalizeUserRole(authUser?.role) === "admin";
  const isTeacher = normalizeUserRole(authUser?.role) === "teacher";
  const hasTeacherStudentView = Boolean(selectedStudentView);
  const navSections = useMemo(
    () => getNavSections(authUser?.role, hasTeacherStudentView),
    [authUser, hasTeacherStudentView],
  );

  const onLogin = async (event) => {
    event.preventDefault();
    setAuthError("");
    setIsAuthenticating(true);

    try {
      const response = await login(username, password);
      const user = response.user
        ? {
          username: String(response.user.username ?? "").trim(),
          fullName: String(response.user.fullName ?? "").trim(),
          role: normalizeUserRole(response.user.role),
        }
        : null;
      setAuthUser(user);
      setBudgetBalance(typeof response.user?.budgetBalance === "number" ? response.user.budgetBalance : null);
      if (user?.username) {
        window.localStorage.setItem(authStorageKey, JSON.stringify(user));
      }
      setSelectedStudentView(null);
      setActivePage("landing");
      setPassword("");
    } catch (error) {
      setAuthError(error.message || "Login failed");
    } finally {
      setIsAuthenticating(false);
    }
  };

  const onLogout = ({ skipServer = false } = {}) => {
    if (!skipServer) {
      logout();
    }
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
    setSelectedStudentView(null);
    setActivePage("landing");
  };
  onLogoutRef.current = onLogout;

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

  if (activePage === "landing") {
    return (
      <div className="login-shell">
        <div className="login-card">
          <p className="login-kicker">{landingContent.kicker}</p>
          <h1 className="login-title">{landingContent.title}</h1>
          <img src={talonLogo} alt="Talon" className="login-logo" />
          <p className="form-hint">Signed in as {authUser.fullName || authUser.username} ({normalizeUserRole(authUser.role)}).</p>
          <p className="form-hint">{landingContent.description}</p>

          <div className="form-group full">
            <label className="form-label">Quick Start</label>
            <ul>
              {landingContent.highlights.map((highlight) => (
                <li key={highlight}>{highlight}</li>
              ))}
            </ul>
          </div>

          <div className="form-group full form-actions submit-actions-row">
            <button type="button" className="btn btn-primary" onClick={() => setActivePage("workspace")}>
              {landingContent.primaryAction}
            </button>
            <button type="button" className="btn btn-secondary" onClick={onLogout}>
              Logout
            </button>
          </div>
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
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setActivePage("landing")}
          >
            Role Home
          </button>
          <div className="topbar-brand">Academies of Loudoun</div>
        </div>
        <div className="topbar-right">
          {normalizeUserRole(authUser.role) === "student" && budgetBalance !== null ? (
            <div className="server-pill" title="Your remaining compute budget">
              Budget {formatDollars(budgetBalance)}
            </div>
          ) : null}
          <div className={`user-menu-wrap${isUserMenuOpen ? " menu-open" : ""}`} ref={userMenuRef}>
            <button
              type="button"
              className="user-pill user-pill-button"
              aria-haspopup="menu"
              aria-expanded={isUserMenuOpen}
              onClick={() => setIsUserMenuOpen((previous) => !previous)}
            >
              <div className="user-avatar">{avatar}</div>
              {authUser.fullName || authUser.username} · {normalizeUserRole(authUser.role)}
            </button>
            <div className="user-menu-hint">Click for account menu</div>
            <div className={`user-menu${isUserMenuOpen ? " open" : ""}`} role="menu">
              <button
                type="button"
                className="user-menu-item"
                role="menuitem"
                onClick={() => {
                  setIsUserMenuOpen(false);
                  setIsPasswordDialogOpen(true);
                }}
              >
                Change password
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

      {isPasswordDialogOpen ? <ChangePasswordDialog onClose={() => setIsPasswordDialogOpen(false)} /> : null}

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
          {isAdmin ? <AdminConsole authUser={authUser} /> : null}

          {!isAdmin && isTeacher && !hasTeacherStudentView ? (
            <TeacherStudentsPanel
              authUser={authUser}
              onOpenStudentView={(student) => setSelectedStudentView(student)}
            />
          ) : null}

          {!isAdmin && isTeacher && hasTeacherStudentView ? (
            <section className="panel" id="teacher-student-view">
              <div className="panel-head">
                <h2 className="panel-title">Student Workspace</h2>
              </div>
              <div className="result-card">
                <div className="result-job-name">Viewing {selectedStudentView.fullName}</div>
                <div className="form-hint mono-sm">{selectedStudentView.username}</div>
                <div className="form-hint">
                  Budget remaining {formatDollars(selectedStudentView.tokensRemaining)} of{" "}
                  {formatDollars(selectedStudentView.quota)}. Read-only: you can see this
                  student&apos;s jobs and results, but only the student (or an admin) can change them.
                </div>
                <div className="form-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setSelectedStudentView(null)}
                  >
                    Back to Class Roster
                  </button>
                </div>
              </div>
            </section>
          ) : null}

          {!isAdmin && (!isTeacher || hasTeacherStudentView) ? (
            <>
          <JobStatusPanel
            jobs={visibleJobs}
            activeFilter={activeFilter}
            setActiveFilter={setActiveFilter}
            statusAvailability={visibleStatusAvailability}
            onCancelJob={onCancelJob}
            onHideJob={onHideJob}
            onUnhideJob={onUnhideJob}
            jobActionError={jobActionError}
            readOnly={isTeacher}
          />
          <ResultsPanel results={visibleResults} jobs={visibleJobs} filesByJobId={filesByJobId} />
          {!isTeacher ? (
            <>
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
            </>
          ) : null}
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
}
