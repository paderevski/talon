import { Router } from "express";
import { getGithubTokenForUser } from "../utils/githubCredentialsStore.js";

const router = Router();
const repoTreeCache = new Map();
const pathCommitCache = new Map();

const repoTreeCacheTtlMs = 10 * 60 * 1000;
const pathCommitCacheTtlMs = 60 * 60 * 1000;

function pruneExpiredCaches() {
  const now = Date.now();

  for (const [key, entry] of repoTreeCache.entries()) {
    if (now - entry.cachedAt > repoTreeCacheTtlMs) {
      repoTreeCache.delete(key);
    }
  }

  for (const [key, entry] of pathCommitCache.entries()) {
    if (now - entry.cachedAt > pathCommitCacheTtlMs) {
      pathCommitCache.delete(key);
    }
  }
}

async function getJsonOrThrow(url, errorMessage) {
  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error(errorMessage);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function getJsonWithHeadersOrThrow(url, errorMessage, headers = {}) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const error = new Error(errorMessage);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function getTalonUserFromRequest(req) {
  return String(req.get("x-talon-user") ?? "").trim();
}

function getGithubHeaders(token) {
  if (!token) {
    return {};
  }

  return {
    Authorization: `Bearer ${token}`,
  };
}

function normalizeRepoPath(value) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");

  if (!normalized) {
    return "";
  }

  if (normalized.split("/").includes("..")) {
    return "";
  }

  return normalized;
}

function formatBytes(bytes) {
  if (typeof bytes !== "number" || Number.isNaN(bytes)) {
    return "";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = -1;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`;
}

async function fetchLatestCommitForPath(
  owner,
  repo,
  branch,
  headSha,
  path,
  githubHeaders,
  skipCache = false,
) {
  const cacheKey = `${owner}/${repo}@${branch}#${headSha}:${path}`;
  const cached = pathCommitCache.get(cacheKey);

  if (
    !skipCache &&
    cached &&
    Date.now() - cached.cachedAt <= pathCommitCacheTtlMs
  ) {
    return cached.value;
  }

  try {
    const commits = await getJsonWithHeadersOrThrow(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?sha=${encodeURIComponent(branch)}&path=${encodeURIComponent(path)}&per_page=1`,
      "Unable to fetch latest commit for path",
      githubHeaders,
    );
    const latestCommit = Array.isArray(commits) ? commits[0] : null;

    if (!latestCommit) {
      const emptyValue = {
        lastCommitMessage: "—",
        updated: "—",
      };
      pathCommitCache.set(cacheKey, {
        cachedAt: Date.now(),
        value: emptyValue,
      });
      return emptyValue;
    }

    const value = {
      lastCommitMessage: latestCommit.commit?.message?.split("\n")[0] || "—",
      updated: latestCommit.commit?.author?.date
        ? new Date(latestCommit.commit.author.date).toLocaleString()
        : "—",
    };

    pathCommitCache.set(cacheKey, { cachedAt: Date.now(), value });
    return value;
  } catch {
    const fallbackValue = {
      lastCommitMessage: "—",
      updated: "—",
    };

    pathCommitCache.set(cacheKey, {
      cachedAt: Date.now(),
      value: fallbackValue,
    });
    return fallbackValue;
  }
}

async function mapContentItem(
  owner,
  repo,
  branch,
  headSha,
  item,
  githubHeaders,
  skipCache = false,
) {
  const commitInfo = await fetchLatestCommitForPath(
    owner,
    repo,
    branch,
    headSha,
    item.path || item.name,
    githubHeaders,
    skipCache,
  );

  return {
    name: item.type === "dir" ? `${item.name}/` : item.name,
    rawName: item.name,
    path: item.path || item.name,
    type: item.type,
    size:
      item.type === "file" && typeof item.size === "number"
        ? formatBytes(item.size)
        : "",
    lastCommitMessage: commitInfo.lastCommitMessage,
    updated: commitInfo.updated,
  };
}

function buildRepoFallbackPayload(owner, repo, branch, warning, cachedPayload) {
  if (cachedPayload && Array.isArray(cachedPayload.items)) {
    return {
      ...cachedPayload,
      stale: true,
      warning,
    };
  }

  return {
    repository: `${owner}/${repo}`,
    branch,
    currentPath: "",
    lastCommit: "unknown",
    items: [],
    stale: true,
    warning,
  };
}

router.get("/:owner/:repo/tree", async (req, res) => {
  const { owner, repo } = req.params;
  const requestedBranch = String(req.query.branch ?? "").trim();
  const requestedPath = normalizeRepoPath(req.query.path);
  const fallbackBranch = requestedBranch || "main";
  const fallbackCacheKey = `${owner}/${repo}@${fallbackBranch}:${requestedPath}`;
  const forceRefresh = String(req.query.force ?? "").trim() === "1";
  const talonUser = getTalonUserFromRequest(req);

  try {
    pruneExpiredCaches();
    const githubToken = talonUser ? await getGithubTokenForUser(talonUser) : "";
    const githubHeaders = getGithubHeaders(githubToken);

    const repoInfo = await getJsonWithHeadersOrThrow(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      "Repository lookup failed",
      githubHeaders,
    );
    const branch = requestedBranch || repoInfo.default_branch || "main";

    const headCommit = await getJsonWithHeadersOrThrow(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(branch)}`,
      "Unable to fetch branch head",
      githubHeaders,
    );

    const headSha = headCommit?.sha || "";
    const cacheKey = `${owner}/${repo}@${branch}:${requestedPath}`;
    const cachedTree = repoTreeCache.get(cacheKey);

    if (
      !forceRefresh &&
      cachedTree &&
      cachedTree.headSha === headSha &&
      Date.now() - cachedTree.cachedAt <= repoTreeCacheTtlMs
    ) {
      return res.json(cachedTree.payload);
    }

    const encodedPathSegment = requestedPath
      ? `/${requestedPath
          .split("/")
          .map((segment) => encodeURIComponent(segment))
          .join("/")}`
      : "";

    const contentsResponse = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents${encodedPathSegment}?ref=${encodeURIComponent(branch)}`,
      { headers: githubHeaders },
    );

    if (!contentsResponse.ok) {
      return res.status(contentsResponse.status).json({
        message: `Unable to read repository contents for branch '${branch}'`,
      });
    }

    const contents = await contentsResponse.json();
    const contentItems = Array.isArray(contents) ? contents : [contents];
    const items = await Promise.all(
      contentItems.map((item) =>
        mapContentItem(
          owner,
          repo,
          branch,
          headSha,
          item,
          githubHeaders,
          forceRefresh,
        ),
      ),
    );

    const payload = {
      repository: `${owner}/${repo}`,
      branch,
      currentPath: requestedPath,
      lastCommit: headCommit?.commit?.author?.date
        ? `Updated ${new Date(headCommit.commit.author.date).toLocaleString()}`
        : "unknown",
      items,
    };

    repoTreeCache.set(cacheKey, {
      cachedAt: Date.now(),
      headSha,
      payload,
    });

    return res.json(payload);
  } catch (error) {
    const status = Number(error?.status ?? 500);

    if (status === 404) {
      return res
        .status(404)
        .json({ message: error?.message || "Repository lookup failed" });
    }

    if ([403, 429, 500, 502, 503, 504].includes(status)) {
      const cachedTree = repoTreeCache.get(fallbackCacheKey);
      return res.json(
        buildRepoFallbackPayload(
          owner,
          repo,
          fallbackBranch,
          "GitHub temporarily unavailable; showing fallback repository data",
          cachedTree?.payload,
        ),
      );
    }

    if (error?.status) {
      return res
        .status(error.status)
        .json({ message: error.message || "Repository lookup failed" });
    }

    return res.status(500).json({ message: "Unable to load repository data" });
  }
});

export default router;
