import { splitRepoPath } from "../utils/repo";

const headers = {
  "Content-Type": "application/json",
};

let currentApiUser = "";

const githubRepoCacheTtlMs = 5 * 60 * 1000;
const githubRepoCache = new Map();

async function getJson(path) {
  const requestHeaders = {
    ...(currentApiUser ? { "x-talon-user": currentApiUser } : {}),
  };

  const response = await fetch(path, {
    headers: requestHeaders,
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

function getRequestHeaders(includeJsonContentType = false, usernameOverride = "") {
  const effectiveUser = String(usernameOverride ?? "").trim() || currentApiUser;
  return {
    ...(includeJsonContentType ? headers : {}),
    ...(effectiveUser ? { "x-talon-user": effectiveUser } : {}),
  };
}

export function setApiAuthUser(username) {
  currentApiUser = String(username ?? "").trim();
}

export function fetchRepoTree(
  repoPath = "jane_smith/bert-nlp",
  branch = "main",
  options = {},
) {
  const force = options.force === true;
  const parsedRepo = splitRepoPath(repoPath);
  if (!parsedRepo) {
    return Promise.resolve({
      repository: repoPath,
      branch,
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

  return getJson(
    `/api/repos/${parsedRepo.owner}/${parsedRepo.repo}/tree?${query.toString()}`,
  );
}

export function fetchJobs(filter = "all") {
  const query = new URLSearchParams({
    status: String(filter || "all"),
  });

  if (filter === "hidden") {
    query.set("includeHidden", "1");
  }

  return getJson(`/api/jobs?${query.toString()}`);
}

export function fetchResults() {
  return getJson("/api/results");
}

export function fetchExecutionDebugSnapshot() {
  return getJson("/api/jobs/debug/executions");
}

export function fetchJobDetails(jobId) {
  return getJson(`/api/jobs/${encodeURIComponent(jobId)}`);
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
  const response = await fetch(
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
  const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, {
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
  const response = await fetch(
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
  const response = await fetch("/api/jobs", {
    method: "POST",
    headers: getRequestHeaders(true),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Submit failed: ${response.status}`);
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

export async function fetchGithubPublicRepos(username) {
  const normalizedUsername = String(username ?? "").trim();
  if (!normalizedUsername) {
    return [];
  }

  const cacheKey = normalizedUsername.toLowerCase();
  const cached = githubRepoCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < githubRepoCacheTtlMs) {
    return cached.repos;
  }

  const response = await fetch(
    `/api/github-credentials/repos/${encodeURIComponent(normalizedUsername)}`,
    {
      headers: getRequestHeaders(),
    },
  );

  if (!response.ok) {
    if (response.status === 403) {
      throw new Error(
        "GitHub API rate limit reached (403). Try again in a few minutes",
      );
    }
    throw new Error(`Unable to load repositories (${response.status})`);
  }

  const body = await response.json();
  const items = Array.isArray(body) ? body : body?.items;
  if (!Array.isArray(items)) {
    return [];
  }

  const repos = items
    .map((item) => {
      if (typeof item === "string") {
        return item.trim();
      }
      return String(item?.full_name ?? "").trim();
    })
    .filter(Boolean);

  githubRepoCache.set(cacheKey, {
    timestamp: Date.now(),
    repos,
  });

  return repos;
}

export async function getGithubTokenStatus(usernameOverride = "") {
  const effectiveUser = String(usernameOverride ?? "").trim() || currentApiUser;
  console.info(
    `[github-credentials][frontend] requesting token status (user='${effectiveUser || "(missing)"}')`,
  );
  const response = await fetch("/api/github-credentials", {
    headers: getRequestHeaders(false, usernameOverride),
  });

  console.info(
    `[github-credentials][frontend] token status response received (status=${response.status})`,
  );

  if (!response.ok) {
    throw new Error(`Unable to load token status (${response.status})`);
  }

  const payload = await response.json();
  console.info(
    `[github-credentials][frontend] token status payload received (hasToken=${Boolean(payload?.hasToken)}, githubUsername='${String(payload?.githubUsername ?? "")}')`,
  );
  return payload;
}

export async function saveGithubToken(token, usernameOverride = "") {
  const effectiveUser = String(usernameOverride ?? "").trim() || currentApiUser;
  console.info(
    `[github-credentials][frontend] sending token save request (user='${effectiveUser || "(missing)"}', tokenProvided=${Boolean(String(token ?? "").trim())})`,
  );
  const response = await fetch("/api/github-credentials", {
    method: "PUT",
    headers: getRequestHeaders(true, usernameOverride),
    body: JSON.stringify({ token }),
  });

  console.info(
    `[github-credentials][frontend] token save response received (status=${response.status})`,
  );

  if (!response.ok) {
    let message = `Unable to save token (${response.status})`;
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

  const payload = await response.json();
  console.info(
    `[github-credentials][frontend] token save payload received (ok=${Boolean(payload?.ok)})`,
  );
  return payload;
}

export async function deleteGithubToken(usernameOverride = "") {
  const effectiveUser = String(usernameOverride ?? "").trim() || currentApiUser;
  console.info(
    `[github-credentials][frontend] sending token delete request (user='${effectiveUser || "(missing)"}')`,
  );
  const response = await fetch("/api/github-credentials", {
    method: "DELETE",
    headers: getRequestHeaders(false, usernameOverride),
  });

  console.info(
    `[github-credentials][frontend] token delete response received (status=${response.status})`,
  );

  if (!response.ok) {
    throw new Error(`Unable to delete token (${response.status})`);
  }

  const payload = await response.json();
  console.info(
    `[github-credentials][frontend] token delete payload received (ok=${Boolean(payload?.ok)})`,
  );
  return payload;
}

export async function saveGithubCredentialSettings(githubUsername, usernameOverride = "") {
  const effectiveUser = String(usernameOverride ?? "").trim() || currentApiUser;
  const normalizedGithubUsername = String(githubUsername ?? "").trim();
  console.info(
    `[github-credentials][frontend] sending github settings save request (user='${effectiveUser || "(missing)"}', githubUsername='${normalizedGithubUsername}')`,
  );

  const response = await fetch("/api/github-credentials", {
    method: "PATCH",
    headers: getRequestHeaders(true, usernameOverride),
    body: JSON.stringify({ githubUsername: normalizedGithubUsername }),
  });

  console.info(
    `[github-credentials][frontend] github settings save response received (status=${response.status})`,
  );

  if (!response.ok) {
    let message = `Unable to save GitHub settings (${response.status})`;
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

  const payload = await response.json();
  console.info(
    `[github-credentials][frontend] github settings payload received (ok=${Boolean(payload?.ok)})`,
  );
  return payload;
}
