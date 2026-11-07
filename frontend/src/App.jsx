import { useEffect, useMemo, useRef, useState } from "react";
import { GatewayError, cancelJob, fetchComputeOptions, fetchCurrentUser, fetchJobFiles, fetchJobs, fetchConnections, fetchResults, hideJob, login, logout, setUnauthorizedHandler, submitJob, unhideJob } from "./api/client";
import NewJobPanel from "./components/NewJobPanel";
import JobStatusPanel from "./components/JobStatusPanel";
import ResultsPanel from "./components/ResultsPanel";
import ConnectionsPanel from "./components/ConnectionsPanel";
import AdminConsole from "./components/AdminConsole";
import ChangePasswordDialog from "./components/ChangePasswordDialog";
import TeacherStudentsPanel from "./components/TeacherStudentsPanel";
import talonLogo from "../../assets/talon-logo.png";
import { formatDollars } from "./utils/format";

// Each nav item is its own view, addressed by the URL hash (#jobs, #users/teachers).
// The first view in the list is where the role lands after sign-in.
function getViews(role, teacherStudent) {
  const normalizedRole = normalizeUserRole(role);

  if (normalizedRole === "teacher") {
    const views = [{ id: "students", label: "Students" }];
    // A teacher looking at one student sees that student's jobs and results.
    if (teacherStudent) {
      views.push({ id: "student", label: teacherStudent.fullName || teacherStudent.username });
    }
    return views;
  }

  const jobViews = [
    { id: "jobs", label: "Jobs", showCount: true },
    { id: "new-job", label: "New Job" },
    { id: "connections", label: "Connections" },
  ];

  if (normalizedRole === "admin") {
    return [
      { id: "overview", label: "Overview" },
      { id: "users", label: "Users" },
      { id: "classes", label: "Classes" },
      { id: "import", label: "Import" },
      ...jobViews,
    ];
  }

  return jobViews;
}

// "#users/teachers" -> { view: "users", sub: "teachers" }
// Old links to #github (the panel before Connections) still land there.
const viewAliases = { github: "connections" };

function readHashRoute() {
  const [view = "", sub = ""] = window.location.hash.replace(/^#\/?/, "").split("/");
  return { view: viewAliases[view] || view, sub };
}

function clearHash() {
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}

const authStorageKey = "talon.authUser";
const fallbackRepo = "";
const fallbackBranch = "main";

const validUserRoles = new Set(["student", "teacher", "admin"]);

const autoStatusFilters = new Set(["completed", "queued", "running"]);

function normalizeUserRole(role) {
  const normalizedRole = String(role ?? "").trim().toLowerCase();
  return validUserRoles.has(normalizedRole) ? normalizedRole : "student";
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

// One-time cleanup: the GitHub username used to be kept in the browser.
try {
  window.localStorage.removeItem("talon.githubSettings");
} catch {
  // Storage unavailable: nothing to clean up.
}

// ?connection=<provider>&result=<code> is set by the server after a sign-in
// round trip (GitHub, later others). Read it once and remove it from the
// address bar. Returns { provider, code } or null.
function takeConnectionResult() {
  const params = new URLSearchParams(window.location.search);
  const provider = params.get("connection") || "";
  const code = params.get("result") || "";
  if (provider || code || params.has("github")) {
    ["connection", "result", "github"].forEach((name) => params.delete(name));
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
  }
  return provider && code ? { provider, code } : null;
}

// Once per page load (not in a state initializer: StrictMode runs those twice).
const connectionResultOnLoad = takeConnectionResult();

export default function App() {
  const [authUser, setAuthUser] = useState(getStoredAuthUser);
  // Coming back from a sign-in the server redirects to #connections.
  const [route, setRoute] = useState(readHashRoute);
  const [focusJobId, setFocusJobId] = useState(null);
  const [connections, setConnections] = useState(null); // null while loading
  const connectionResult = connectionResultOnLoad;
  const githubConnection = connections?.find((c) => c.provider === "github") || null;
  const driveConnection = connections?.find((c) => c.provider === "google_drive") || null;
  const [selectedStudentView, setSelectedStudentView] = useState(null);
  const [budgetBalance, setBudgetBalance] = useState(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const [isPasswordDialogOpen, setIsPasswordDialogOpen] = useState(false);
  // The repo and branch of the last job submitted from GitHub: the New Job
  // form starts from them.
  const [repoPath, setRepoPath] = useState(fallbackRepo);
  const [repoBranch, setRepoBranch] = useState(fallbackBranch);
  const [jobs, setJobs] = useState([]);
  const [allJobs, setAllJobs] = useState([]);
  const [results, setResults] = useState([]);
  const [filesByJobId, setFilesByJobId] = useState({});
  const [jobActionError, setJobActionError] = useState("");
  const [activeFilter, setActiveFilter] = useState("completed");
  const [statusAvailability, setStatusAvailability] = useState({
    hasRunning: false,
    hasQueued: false,
  });
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

  // Result cards read their files from the stored result. Only a job that is
  // still active has no result yet, so only those need a files request; the
  // list endpoint already brings every job's status up to date.
  const hydrateJobRuntime = async (jobList) => {
    const active = jobList.filter((job) => job.status === "queued" || job.status === "running");
    const fileResults = await Promise.allSettled(active.map((job) => fetchJobFiles(job.id)));

    setFilesByJobId((previous) => {
      const next = {};
      jobList.forEach((job) => {
        if (previous[job.id]) {
          next[job.id] = previous[job.id];
        }
      });
      active.forEach((job, index) => {
        if (fileResults[index].status === "fulfilled") {
          next[job.id] = fileResults[index].value.items || [];
        }
      });
      return next;
    });
  };

  const load = async () => {
    void refreshBudget();
    const [jobsResult, allJobsResult, resultsResult] = await Promise.allSettled([
      fetchJobs(activeFilter, { owner: viewedOwner }),
      fetchJobs("all", { owner: viewedOwner }),
      fetchResults({ owner: viewedOwner })
    ]);

    if (jobsResult.status === "fulfilled") {
      const items = jobsResult.value.items || [];
      setJobs(items);
      await hydrateJobRuntime(items);
    } else {
      setJobs([]);
      setAllJobs([]);
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
  }, [authUser, activeFilter, effectiveOwnerUsername]);

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

  // The form builds the payload, code source included; the server assigns
  // the job to whoever is signed in.
  const onSubmitJob = async (payload) => {

    let result;
    try {
      result = await submitJob(payload);
    } catch (error) {
      // The job may have started anyway: show it in the list if it did.
      if (error instanceof GatewayError) {
        await refreshJobs().catch(() => {});
      }
      throw error;
    }
    if (payload.source?.type === "github" && payload.source.repo) {
      setRepoPath(payload.source.repo);
      setRepoBranch(payload.source.branch || fallbackBranch);
    }
    await refreshJobs();
    // An EC2 job: go to Jobs with its progress open, to watch it launch
    // (it is still being prepared when submit answers).
    if (result?.job?.executionProvider === "ec2") {
      setFocusJobId(result.job.id);
      window.location.hash = "jobs";
    }
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
  const isAdmin = normalizeUserRole(authUser?.role) === "admin";
  const [computeOptions, setComputeOptions] = useState(null);
  const signedInUsername = authUser?.username || "";
  useEffect(() => {
    if (!signedInUsername) {
      setComputeOptions(null);
      return;
    }
    fetchComputeOptions()
      .then((data) => setComputeOptions(data))
      .catch(() => setComputeOptions(null));
  }, [signedInUsername]);
  const loadConnections = () => {
    fetchConnections()
      .then((items) => setConnections(items))
      .catch(() => setConnections([]));
  };
  useEffect(() => {
    setConnections(null);
    if (signedInUsername) {
      loadConnections();
    }
  }, [signedInUsername]);
  const isTeacher = normalizeUserRole(authUser?.role) === "teacher";
  const hasTeacherStudentView = Boolean(selectedStudentView);
  const views = useMemo(
    () => getViews(authUser?.role, selectedStudentView),
    [authUser, selectedStudentView],
  );
  const activeView = views.some((view) => view.id === route.view) ? route.view : views[0].id;

  useEffect(() => {
    const onHashChange = () => setRoute(readHashRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // The submitted job's progress opens once, not on every return to Jobs.
  useEffect(() => {
    if (activeView !== "jobs") {
      setFocusJobId(null);
    }
  }, [activeView]);

  // A new view starts at the top, not wherever the previous one was scrolled.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [activeView]);

  const openStudentView = (student) => {
    setSelectedStudentView(student);
    window.location.hash = "student";
  };
  const closeStudentView = () => {
    setSelectedStudentView(null);
    window.location.hash = "students";
  };

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
      clearHash();
      setRoute(readHashRoute());
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
    setUsername("");
    setPassword("");
    setAuthError("");
    setJobs([]);
    setResults([]);
    setFilesByJobId({});
    setJobActionError("");
    setActiveFilter("completed");
    setSelectedStudentView(null);
    clearHash();
    setRoute(readHashRoute());
  };
  onLogoutRef.current = onLogout;

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
              <a className="user-menu-item" href="#connections" role="menuitem" onClick={() => setIsUserMenuOpen(false)}>
                Connections
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
          {views.map((view) => (
            <a
              key={view.id}
              href={`#${view.id}`}
              className={`nav-item${view.id === activeView ? " active" : ""}`}
              aria-current={view.id === activeView ? "page" : undefined}
              onClick={() => setIsMobileNavOpen(false)}
            >
              {view.label}
              {view.showCount ? <span className="nav-count">{statusCount}</span> : null}
            </a>
          ))}
        </nav>

        <main className="main">
          {isAdmin ? <AdminConsole authUser={authUser} view={activeView} sub={route.sub} /> : null}

          {isTeacher && activeView === "students" ? (
            <TeacherStudentsPanel authUser={authUser} onOpenStudentView={openStudentView} />
          ) : null}

          {isTeacher && activeView === "student" && hasTeacherStudentView ? (
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
                  <button type="button" className="btn btn-secondary btn-sm" onClick={closeStudentView}>
                    Back to Class Roster
                  </button>
                </div>
              </div>
            </section>
          ) : null}

          {activeView === "jobs" || activeView === "student" ? (
            <>
              <JobStatusPanel
                jobs={visibleJobs}
                allJobs={visibleAllJobs}
                focusJobId={activeView === "jobs" ? focusJobId : null}
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
            </>
          ) : null}

          {activeView === "new-job" ? (
            <>
              <NewJobPanel
                onSubmit={onSubmitJob}
                defaultRepo={repoPath}
                defaultBranch={repoBranch}
                githubLinked={Boolean(githubConnection?.configured && githubConnection?.linked)}
                githubLogin={githubConnection?.account?.login || ""}
                driveLinked={Boolean(driveConnection?.configured && driveConnection?.linked && !driveConnection?.needsReconnect)}
                driveLogin={driveConnection?.account?.login || ""}
                compute={computeOptions}
                budgetDollars={normalizeUserRole(authUser?.role) === "student" ? budgetBalance : null}
              />
            </>
          ) : null}

          {activeView === "connections" ? (
            <ConnectionsPanel
              connections={connections}
              result={connectionResult}
              onChanged={loadConnections}
            />
          ) : null}
        </main>
      </div>
    </div>
  );
}
