const repoSegmentPattern = /^[A-Za-z0-9_.-]+$/;

export function normalizeRepoInput(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }

  const withoutGitSuffix = raw.replace(/\.git$/i, "");

  if (/^git@github\.com:/i.test(withoutGitSuffix)) {
    return withoutGitSuffix
      .replace(/^git@github\.com:/i, "")
      .replace(/^\//, "");
  }

  if (/^https?:\/\//i.test(withoutGitSuffix)) {
    try {
      const parsed = new URL(withoutGitSuffix);
      if (parsed.hostname.toLowerCase() === "github.com") {
        const parts = parsed.pathname.split("/").filter(Boolean);
        if (parts.length >= 2) {
          return `${parts[0]}/${parts[1]}`;
        }
      }
    } catch {
      // Fall through to plain-text normalization.
    }
  }

  return withoutGitSuffix
    .replace(/^github\.com\//i, "")
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^\//, "");
}

export function normalizeRepoPath(value) {
  const normalizedInput = normalizeRepoInput(value);
  if (!normalizedInput) {
    return "";
  }

  const parts = normalizedInput.split("/").filter(Boolean);
  if (parts.length !== 2) {
    return "";
  }

  const [owner, repo] = parts;
  if (!repoSegmentPattern.test(owner) || !repoSegmentPattern.test(repo)) {
    return "";
  }

  return `${owner}/${repo}`;
}

export function splitRepoPath(value) {
  const normalizedPath = normalizeRepoPath(value);
  if (!normalizedPath) {
    return null;
  }

  const [owner, repo] = normalizedPath.split("/");
  return { owner, repo, path: normalizedPath };
}

export function isValidRepoPath(value) {
  return Boolean(normalizeRepoPath(value));
}

export function assertRepoPath(
  value,
  errorMessage = "Invalid repository format. Expected owner/repo",
) {
  const normalizedPath = normalizeRepoPath(value);
  if (!normalizedPath) {
    throw new Error(errorMessage);
  }

  return normalizedPath;
}

// A folder inside the repository: "" is the root. Plain relative paths only
// (letters, digits, _ . - per segment, no "..", no empty segments). Returns
// the cleaned folder, or null when it is not allowed.
const folderSegmentPattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

export function normalizeFolder(value) {
  const cleaned = String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+|\/+$/g, "");
  if (!cleaned || cleaned === ".") {
    return "";
  }
  const segments = cleaned.split("/");
  if (segments.some((segment) => !folderSegmentPattern.test(segment) || segment === "..")) {
    return null;
  }
  return segments.join("/");
}

// Reads a GitHub URL pasted from the browser:
//   https://github.com/o/r                      -> { repo }
//   https://github.com/o/r/tree/<branch>/a/b    -> { repo, branch, folder: "a/b" }
//   https://github.com/o/r/blob/<branch>/a/x.py -> { repo, branch, folder: "a", entryScript: "x.py" }
// The branch is taken to be the first segment after tree/blob (a branch with
// a "/" in its name cannot be told apart from a folder). null if it is not a
// GitHub repository URL.
export function parseGithubUrl(value) {
  const text = String(value ?? "").trim();
  let parsed = null;
  if (/^(https?:\/\/)?(www\.)?github\.com\//i.test(text)) {
    try {
      parsed = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
      parsed = null;
    }
  }
  if (!parsed) {
    const repo = normalizeRepoPath(text);
    return repo ? { repo } : null;
  }

  const [owner, name, kind, branch, ...rest] = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const repo = normalizeRepoPath(`${owner ?? ""}/${String(name ?? "").replace(/\.git$/i, "")}`);
  if (!repo) {
    return null;
  }
  const result = { repo };
  if ((kind !== "tree" && kind !== "blob") || !branch) {
    return result;
  }
  result.branch = branch;
  let folderParts = rest;
  if (kind === "blob" && rest.length) {
    result.entryScript = rest[rest.length - 1];
    folderParts = rest.slice(0, -1);
  }
  const folder = normalizeFolder(folderParts.join("/"));
  if (folder) {
    result.folder = folder;
  }
  return result;
}
