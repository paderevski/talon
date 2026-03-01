const headers = {
  "Content-Type": "application/json",
};

const githubRepoCacheTtlMs = 5 * 60 * 1000;
const githubRepoCache = new Map();

async function getJson(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
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
    headers,
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
    headers,
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
    `https://api.github.com/users/${encodeURIComponent(normalizedUsername)}/repos?type=public&sort=updated&per_page=100`,
  );

  if (!response.ok) {
    if (response.status === 403) {
      throw new Error(
        "GitHub API rate limit reached (403). Try again in a few minutes",
      );
    }
    throw new Error(`Unable to load repositories (${response.status})`);
  }

  const items = await response.json();
  if (!Array.isArray(items)) {
    return [];
  }

  const repos = items
    .map((item) => String(item?.full_name ?? "").trim())
    .filter(Boolean);

  githubRepoCache.set(cacheKey, {
    timestamp: Date.now(),
    repos,
  });

  return repos;
}
