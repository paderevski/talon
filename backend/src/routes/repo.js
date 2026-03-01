import { Router } from "express";

const router = Router();

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

async function fetchLatestCommitForPath(owner, repo, branch, path) {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?sha=${encodeURIComponent(branch)}&path=${encodeURIComponent(path)}&per_page=1`,
    );

    if (!response.ok) {
      return {
        lastCommitMessage: "—",
        updated: "—",
      };
    }

    const commits = await response.json();
    const latestCommit = Array.isArray(commits) ? commits[0] : null;

    if (!latestCommit) {
      return {
        lastCommitMessage: "—",
        updated: "—",
      };
    }

    return {
      lastCommitMessage: latestCommit.commit?.message?.split("\n")[0] || "—",
      updated: latestCommit.commit?.author?.date
        ? new Date(latestCommit.commit.author.date).toLocaleString()
        : "—",
    };
  } catch {
    return {
      lastCommitMessage: "—",
      updated: "—",
    };
  }
}

async function mapContentItem(owner, repo, branch, item) {
  const commitInfo = await fetchLatestCommitForPath(
    owner,
    repo,
    branch,
    item.path || item.name,
  );

  return {
    name: item.type === "dir" ? `📁 ${item.name}` : item.name,
    size:
      item.type === "file" && typeof item.size === "number"
        ? formatBytes(item.size)
        : "",
    lastCommitMessage: commitInfo.lastCommitMessage,
    updated: commitInfo.updated,
  };
}

router.get("/:owner/:repo/tree", async (req, res) => {
  const { owner, repo } = req.params;
  const requestedBranch = String(req.query.branch ?? "").trim();

  try {
    const repoResponse = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    );

    if (!repoResponse.ok) {
      return res
        .status(repoResponse.status)
        .json({ message: "Repository lookup failed" });
    }

    const repoInfo = await repoResponse.json();
    const branch = requestedBranch || repoInfo.default_branch || "main";

    const contentsResponse = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents?ref=${encodeURIComponent(branch)}`,
    );

    if (!contentsResponse.ok) {
      return res.status(contentsResponse.status).json({
        message: `Unable to read repository contents for branch '${branch}'`,
      });
    }

    const contents = await contentsResponse.json();
    const contentItems = Array.isArray(contents) ? contents : [contents];
    const items = await Promise.all(
      contentItems.map((item) => mapContentItem(owner, repo, branch, item)),
    );

    return res.json({
      repository: `${owner}/${repo}`,
      branch,
      lastCommit: repoInfo.pushed_at
        ? `Updated ${new Date(repoInfo.pushed_at).toLocaleString()}`
        : "unknown",
      items,
    });
  } catch {
    return res.status(500).json({ message: "Unable to load repository data" });
  }
});

export default router;
