import { Router } from "express";
import { repoDirectory } from "../data/mockData.js";

const router = Router();

router.get("/:owner/:repo/tree", (req, res) => {
  const { owner, repo } = req.params;

  res.json({
    repository: `${owner}/${repo}`,
    branch: "main",
    lastCommit: '2h ago · "fix learning rate scheduler"',
    items: repoDirectory,
  });
});

export default router;
