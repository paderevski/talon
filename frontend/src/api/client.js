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

function getRequestHeaders(includeJsonContentType = false) {
  return {
    ...(includeJsonContentType ? headers : {}),
    ...(currentApiUser ? { "x-talon-user": currentApiUser } : {}),
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
  const [owner, repo] = repoPath.split("/");
  if (!owner || !repo) {
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

  return getJson(`/api/repos/${owner}/${repo}/tree?${query.toString()}`);
}

export function fetchJobs(filter = "all") {
  return getJson(`/api/jobs?status=${encodeURIComponent(filter)}`);
}

export function fetchResults() {
  return getJson("/api/results");
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

export async function getGithubTokenStatus() {
  const response = await fetch("/api/github-credentials", {
    headers: getRequestHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Unable to load token status (${response.status})`);
  }

  return response.json();
}

export async function saveGithubToken(token) {
  const response = await fetch("/api/github-credentials", {
    method: "PUT",
    headers: getRequestHeaders(true),
    body: JSON.stringify({ token }),
  });

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

  return response.json();
}

export async function deleteGithubToken() {
  const response = await fetch("/api/github-credentials", {
    method: "DELETE",
    headers: getRequestHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Unable to delete token (${response.status})`);
  }

  return response.json();
}
