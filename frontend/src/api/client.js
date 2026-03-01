const headers = {
  "Content-Type": "application/json",
};

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
) {
  const [owner, repo] = repoPath.split("/");
  if (!owner || !repo) {
    return Promise.resolve({
      repository: repoPath,
      branch,
      lastCommit: "unknown",
      items: [],
    });
  }
  return getJson(
    `/api/repos/${owner}/${repo}/tree?branch=${encodeURIComponent(branch || "main")}`,
  );
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

  const response = await fetch(
    `https://api.github.com/users/${encodeURIComponent(normalizedUsername)}/repos?type=public&sort=updated&per_page=100`,
  );

  if (!response.ok) {
    throw new Error(`Unable to load repositories (${response.status})`);
  }

  const items = await response.json();
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item) => String(item?.full_name ?? "").trim())
    .filter(Boolean);
}
