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

  const normalized = withoutGitSuffix
    .replace(/^github\.com\//i, "")
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^\//, "");

  return normalized;
}
