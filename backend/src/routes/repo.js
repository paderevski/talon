import { Router } from "express";
import { isRepoSegment } from "talon-shared/repo";
import { getGithubApp } from "../services/githubApp.js";

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

// Signed-in user's id (requireAuth runs before this router). The old
// x-talon-user header is no longer trusted. Credentials are keyed by id.
function getTalonUserFromRequest(req) {
  return String(req.user?.id ?? "").trim();
}

function getGithubHeaders(token) {
  if (!token) {
    return {};
  }

  return {
    Authorization: `Bearer ${token}`,
  };
}

// A folder inside the repository from ?path= ("" = the top; "" if it has
// ".."). Slashes are trimmed with a loop: /\/+$/ is quadratic on input made
// of many slashes.
function normalizeRepoPath(value) {
  const text = String(value ?? "").trim().replace(/\\/g, "/");
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === "/") start += 1;
  while (end > start && text[end - 1] === "/") end -= 1;
  const normalized = text.slice(start, end);

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

// githubApp: the GitHub App service (a function, so tests can pass a fake).
export function createRepoRouter({ githubApp = getGithubApp } = {}) {
  const router = Router();

  // Branches of a repository, for the submit form's branch menu:
  // { defaultBranch, branches: [names] } (up to 300). Uses the user's GitHub
  // token when linked (private repos), else anonymous; a revoked token is
  // forgotten and the call retried anonymously.
  router.get("/:owner/:repo/branches", async (req, res) => {
    const { owner, repo } = req.params;
    if (!isRepoSegment(owner) || !isRepoSegment(repo)) {
      return res.status(400).json({ message: "Invalid repository" });
    }
    const talonUser = getTalonUserFromRequest(req);
    const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const githubToken = talonUser ? (await githubApp().getUserAccessToken(talonUser)) || "" : "";
    let headers = getGithubHeaders(githubToken);

    const get = async (url) => {
      let response = await fetch(url, { headers });
      if (response.status === 401 && headers.Authorization) {
        await githubApp().forgetRevokedLink(talonUser);
        headers = {};
        response = await fetch(url, { headers });
      }
      return response;
    };

    try {
      const info = await get(base);
      if (!info.ok) {
        const status = info.status === 404 ? 404 : 502;
        return res.status(status).json({ message: status === 404 ? `Repository ${owner}/${repo} was not found` : `GitHub answered ${info.status}` });
      }
      const { default_branch: defaultBranch = "main" } = await info.json();
      const branches = [];
      for (let page = 1; page <= 3; page += 1) {
        const response = await get(`${base}/branches?per_page=100&page=${page}`);
        if (!response.ok) {
          break;
        }
        const items = await response.json();
        branches.push(...items.map((b) => b.name).filter(Boolean));
        if (items.length < 100) {
          break;
        }
      }
      if (!branches.includes(defaultBranch)) {
        branches.unshift(defaultBranch);
      }
      branches.sort((a, b) => (a === defaultBranch ? -1 : b === defaultBranch ? 1 : a.localeCompare(b)));
      return res.json({ defaultBranch, branches });
    } catch (error) {
      return res.status(502).json({ message: "Could not reach GitHub" });
    }
  });

  router.get("/:owner/:repo/tree", async (req, res) => {
    const { owner, repo } = req.params;
    if (!isRepoSegment(owner) || !isRepoSegment(repo)) {
      return res.status(400).json({ message: "Invalid repository" });
    }
    const requestedBranch = String(req.query.branch ?? "").trim();
    const requestedPath = normalizeRepoPath(req.query.path);
    const fallbackBranch = requestedBranch || "main";
    const fallbackCacheKey = `${owner}/${repo}@${fallbackBranch}:${requestedPath}`;
    const forceRefresh = String(req.query.force ?? "").trim() === "1";
    const talonUser = getTalonUserFromRequest(req);

    try {
      pruneExpiredCaches();
      // The user's own GitHub App token: sees their public repos plus the private
      // ones the app is installed on. Not linked: anonymous (public repos only).
      const githubToken = talonUser ? (await githubApp().getUserAccessToken(talonUser)) || "" : "";
      let githubHeaders = getGithubHeaders(githubToken);

      const repoInfoUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
      const notFound = `Repository ${owner}/${repo} was not found. Check the name; for a private repo, connect GitHub and give the Talon app access to it (GitHub panel).`;
      let repoInfo;
      try {
        repoInfo = await getJsonWithHeadersOrThrow(repoInfoUrl, notFound, githubHeaders);
      } catch (error) {
        // A revoked token: forget the link and carry on anonymously.
        if (error?.status !== 401 || !githubToken) {
          throw error;
        }
        await githubApp().forgetRevokedLink(talonUser);
        githubHeaders = {};
        repoInfo = await getJsonWithHeadersOrThrow(repoInfoUrl, notFound, githubHeaders);
      }
      const branch = requestedBranch || repoInfo.default_branch || "main";

      // GitHub answers 422 (sometimes 404) for a branch that does not exist.
      const headCommit = await getJsonWithHeadersOrThrow(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(branch)}`,
        "Unable to fetch branch head",
        githubHeaders,
      ).catch((error) => {
        if (error?.status === 404 || error?.status === 422) {
          error.status = 404;
          error.message = `Branch '${branch}' was not found in ${owner}/${repo}. The default branch is '${repoInfo.default_branch || "main"}'.`;
        }
        throw error;
      });

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
        // Never pass GitHub's 401 through: to the browser it means "signed out".
        return res.status(contentsResponse.status === 401 ? 502 : contentsResponse.status).json({
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
        // A private repo's listing is only ever served from here to the user
        // who loaded it: the fallback below skips GitHub's access check.
        visibleTo: repoInfo.private === false ? null : talonUser,
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
        const cached = repoTreeCache.get(fallbackCacheKey);
        const cachedTree = cached && (cached.visibleTo === null || cached.visibleTo === talonUser) ? cached : null;
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
          .status(error.status === 401 ? 502 : error.status)
          .json({ message: error.message || "Repository lookup failed" });
      }

      return res.status(500).json({ message: "Unable to load repository data" });
    }
  });

  return router;
}

export default createRepoRouter();
