import { splitRepoPath } from "../utils/repo";

const headers = {
  "Content-Type": "application/json",
};

// Identity comes from the httpOnly session cookie (sent automatically on
// same-origin requests). The client no longer tells the server who it is.
let onUnauthorized = () => {};

export function setUnauthorizedHandler(handler) {
  onUnauthorized = typeof handler === "function" ? handler : () => {};
}

async function apiFetch(path, options) {
  const response = await fetch(path, { credentials: "same-origin", ...options });
  if (response.status === 401 && !String(path).startsWith("/api/auth/")) {
    onUnauthorized();
  }
  return response;
}

async function getJson(path) {
  const response = await apiFetch(path);
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.message || `Request failed: ${response.status}`);
  }
  return response.json();
}

function getRequestHeaders(includeJsonContentType = false) {
  return includeJsonContentType ? { ...headers } : {};
}

// { defaultBranch, branches } for a repository (owner/repo).
export function fetchRepoBranches(repoPath) {
  const parsed = splitRepoPath(repoPath);
  if (!parsed) {
    return Promise.reject(new Error("Invalid repository"));
  }
  return getJson(`/api/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/branches`);
}

export function fetchRepoTree(
  repoPath = "jane_smith/bert-nlp",
  branch = "main",
  options = {},
) {
  const force = options.force === true;
  const currentPath = String(options.path ?? "").trim();
  const parsedRepo = splitRepoPath(repoPath);
  if (!parsedRepo) {
    return Promise.resolve({
      repository: repoPath,
      branch,
      currentPath,
      lastCommit: "unknown",
      items: [],
    });
  }

  const query = new URLSearchParams({
    branch: branch || "main",
  });

  if (force) {
    query.set("force", "1");
  }

  if (currentPath) {
    query.set("path", currentPath);
  }

  return getJson(
    `/api/repos/${parsedRepo.owner}/${parsedRepo.repo}/tree?${query.toString()}`,
  );
}

// `owner` (a username) narrows the list to one person within what the
// signed-in user may already see; a teacher uses it to look at one student.
export function fetchJobs(filter = "all", { owner = "" } = {}) {
  const query = new URLSearchParams({
    status: String(filter || "all"),
  });

  if (owner) {
    query.set("owner", owner);
  }

  if (filter === "hidden") {
    query.set("includeHidden", "1");
  }

  return getJson(`/api/jobs?${query.toString()}`);
}

// What the submit form may offer (EC2 instance types, admins only for now).
export function fetchComputeOptions() {
  return getJson("/api/jobs/compute-options");
}

export function fetchResults({ owner = "" } = {}) {
  return getJson(owner ? `/api/results?owner=${encodeURIComponent(owner)}` : "/api/results");
}

export function fetchJobLogs(jobId, cursor = 0) {
  return getJson(`/api/jobs/${encodeURIComponent(jobId)}/logs?cursor=${encodeURIComponent(cursor)}`);
}

export function fetchJobFiles(jobId) {
  return getJson(`/api/jobs/${encodeURIComponent(jobId)}/files`);
}

export function getJobFileDownloadUrl(jobId, fileName, source) {
  const query = new URLSearchParams({
    name: String(fileName || ""),
  });

  if (source) {
    query.set("source", String(source));
  }

  return `/api/jobs/${encodeURIComponent(jobId)}/files/download?${query.toString()}`;
}

export async function cancelJob(jobId) {
  const response = await apiFetch(
    `/api/jobs/${encodeURIComponent(jobId)}/cancel`,
    {
      method: "POST",
      headers: getRequestHeaders(),
    },
  );

  if (!response.ok) {
    let message = `Unable to cancel job (${response.status})`;
    try {
      const body = await response.json();
      if (body?.message) {
        message = body.message;
      }
    } catch {
      // Ignore parse errors and keep fallback message.
    }
    throw new Error(message);
  }

  return response.json();
}

export async function hideJob(jobId, reason) {
  const response = await apiFetch(`/api/jobs/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
    headers: getRequestHeaders(true),
    body: JSON.stringify({ reason }),
  });

  if (!response.ok) {
    let message = `Unable to hide job (${response.status})`;
    try {
      const body = await response.json();
      if (body?.message) {
        message = body.message;
      }
    } catch {
      // Ignore parse errors and keep fallback message.
    }
    throw new Error(message);
  }

  return response.json();
}

export async function unhideJob(jobId) {
  const response = await apiFetch(
    `/api/jobs/${encodeURIComponent(jobId)}/unhide`,
    {
      method: "POST",
      headers: getRequestHeaders(),
    },
  );

  if (!response.ok) {
    let message = `Unable to unhide job (${response.status})`;
    try {
      const body = await response.json();
      if (body?.message) {
        message = body.message;
      }
    } catch {
      // Ignore parse errors and keep fallback message.
    }
    throw new Error(message);
  }

  return response.json();
}

export async function submitJob(payload) {
  const response = await apiFetch("/api/jobs", {
    method: "POST",
    headers: getRequestHeaders(true),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let message = `Submit failed: ${response.status}`;
    try {
      message = (await response.json()).message || message;
    } catch {
      // keep the status message
    }
    throw new Error(message);
  }

  return response.json();
}

export async function login(username, password) {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: getRequestHeaders(true),
    body: JSON.stringify({ username, password }),
  });

  if (!response.ok) {
    let message = `Login failed: ${response.status}`;
    try {
      const body = await response.json();
      if (body?.message) {
        message = body.message;
      }
    } catch {
      // Ignore JSON parse errors and keep fallback message.
    }
    throw new Error(message);
  }

  return response.json();
}

export async function fetchAdminRoster() {
  const response = await apiFetch("/api/admin/roster", {
    headers: getRequestHeaders(),
  });

  if (!response.ok) {
    let message = `Unable to load admin roster (${response.status})`;
    try {
      const body = await response.json();
      if (body?.message) {
        message = body.message;
      }
    } catch {
      // Ignore parse errors and keep fallback message.
    }
    throw new Error(message);
  }

  return response.json();
}

export async function fetchTeacherRoster() {
  const response = await apiFetch("/api/teacher/students", {
    headers: getRequestHeaders(),
  });

  if (!response.ok) {
    let message = `Unable to load teacher roster (${response.status})`;
    try {
      const body = await response.json();
      if (body?.message) {
        message = body.message;
      }
    } catch {
      // Ignore parse errors and keep fallback message.
    }
    throw new Error(message);
  }

  return response.json();
}

// GitHub App link: { configured, linked, login, linkedAt }.
export function getGithubStatus() {
  return getJson("/api/github");
}

// Repositories the Talon app can see for the signed-in user:
// [{ fullName, private }]. Not cached: the list belongs to whoever is signed in.
export async function fetchGithubRepos() {
  const body = await getJson("/api/github/repos");
  return Array.isArray(body?.items) ? body.items : [];
}

export async function disconnectGithub() {
  const response = await apiFetch("/api/github", { method: "DELETE" });
  if (!response.ok) {
    throw new Error(`Unable to disconnect GitHub (${response.status})`);
  }
  return response.json();
}

// Full-page navigations (the server redirects to GitHub and back).
export const githubConnectUrl = "/api/github/connect";
export const githubChooseReposUrl = "/api/github/connect?mode=install";

export async function fetchCurrentUser() {
  const response = await fetch("/api/auth/me", { credentials: "same-origin" });
  if (response.status === 401) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Session check failed: ${response.status}`);
  }
  const body = await response.json();
  return body?.user ?? null;
}

export async function logout() {
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
}

// JSON request helper for the management endpoints. Throws Error(message)
// with the server's message when the request fails.
async function requestJson(method, path, body) {
  const response = await apiFetch(path, {
    method,
    headers: getRequestHeaders(body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    // Non-JSON error body; fall through to the status message.
  }

  if (!response.ok) {
    throw new Error(payload?.message || `Request failed (${response.status})`);
  }

  return payload;
}

export const fetchAdminUsers = () => requestJson("GET", "/api/admin/users");
export const createAdminUser = (user) => requestJson("POST", "/api/admin/users", user);
export const updateAdminUser = (id, changes) =>
  requestJson("PATCH", `/api/admin/users/${encodeURIComponent(id)}`, changes);
export const resetAdminUserPassword = (id) =>
  requestJson("POST", `/api/admin/users/${encodeURIComponent(id)}/reset-password`);
export const unlockAdminUser = (id) =>
  requestJson("POST", `/api/admin/users/${encodeURIComponent(id)}/unlock`);

export const unlinkAdminUserGithub = (id) =>
  requestJson("DELETE", `/api/admin/users/${encodeURIComponent(id)}/github`);

export const fetchAdminClasses = () => requestJson("GET", "/api/admin/classes");
export const createAdminClass = (classInfo) => requestJson("POST", "/api/admin/classes", classInfo);
export const updateAdminClass = (id, changes) =>
  requestJson("PATCH", `/api/admin/classes/${encodeURIComponent(id)}`, changes);
export const addAdminClassMember = (classId, userId, memberRole) =>
  requestJson("POST", `/api/admin/classes/${encodeURIComponent(classId)}/members`, {
    userId,
    memberRole,
  });
export const removeAdminClassMember = (classId, userId) =>
  requestJson(
    "DELETE",
    `/api/admin/classes/${encodeURIComponent(classId)}/members/${encodeURIComponent(userId)}`,
  );

// direction: "increase" | "decrease"; target: "personal" | "pool"; amount in dollars.
export const adjustAdminBudget = (adjustment) =>
  requestJson("POST", "/api/admin/budget/adjustments", adjustment);
export const allocateStudentBudget = (studentUsername, amount) =>
  requestJson("POST", "/api/teacher/allocations", { studentUsername, amount });
export const changeOwnPassword = (currentPassword, newPassword) =>
  requestJson("POST", "/api/auth/password", { currentPassword, newPassword });

// dryRun true previews without writing; false imports and returns the passwords.
export const importRoster = (csv, { defaultRole = "student", dryRun = true } = {}) =>
  requestJson("POST", "/api/admin/import", { csv, defaultRole, dryRun });
