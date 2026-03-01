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
