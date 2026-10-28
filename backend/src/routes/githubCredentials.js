import { Router } from "express";
import {
  deleteGithubTokenForUser,
  getGithubTokenForUser,
  getGithubTokenStatusForUser,
  saveGithubUsernameForUser,
  saveGithubTokenForUser,
} from "../utils/githubCredentialsStore.js";

const router = Router();

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

router.get("/", async (req, res) => {
  const talonUser = getTalonUserFromRequest(req);

  if (!talonUser) {
    return res.json({
      hasToken: false,
      tokenLast4: "",
      githubUsername: "",
      updatedAt: null,
    });
  }

  const status = await getGithubTokenStatusForUser(talonUser);
  return res.json(status);
});

router.put("/", async (req, res) => {
  const talonUser = getTalonUserFromRequest(req);
  const token = String(req.body?.token ?? "").trim();
  const githubUsername = String(req.body?.githubUsername ?? "").trim();

  if (!talonUser) {
    return res.status(401).json({ message: "Sign in required" });
  }

  if (!token) {
    return res.status(400).json({ message: "Token is required" });
  }

  const testResponse = await fetch("https://api.github.com/user", {
    headers: getGithubHeaders(token),
  });


  if (!testResponse.ok) {
    return res.status(400).json({ message: "Invalid GitHub token" });
  }

  await saveGithubTokenForUser(talonUser, token, githubUsername);
  const status = await getGithubTokenStatusForUser(talonUser);
  return res.json({ ok: true, status });
});

router.patch("/", async (req, res) => {
  const talonUser = getTalonUserFromRequest(req);
  const githubUsername = String(req.body?.githubUsername ?? "").trim();

  if (!talonUser) {
    return res.status(401).json({ message: "Sign in required" });
  }

  await saveGithubUsernameForUser(talonUser, githubUsername);
  const status = await getGithubTokenStatusForUser(talonUser);
  return res.json({ ok: true, status });
});

router.delete("/", async (req, res) => {
  const talonUser = getTalonUserFromRequest(req);

  if (!talonUser) {
    return res.status(401).json({ message: "Sign in required" });
  }

  await deleteGithubTokenForUser(talonUser);
  return res.json({ ok: true });
});

router.get("/repos/:username", async (req, res) => {
  const githubUsername = String(req.params.username ?? "").trim();
  const talonUser = getTalonUserFromRequest(req);

  if (!githubUsername) {
    return res.status(400).json({ message: "GitHub username is required" });
  }

  const token = talonUser ? await getGithubTokenForUser(talonUser) : "";
  const response = await fetch(
    `https://api.github.com/users/${encodeURIComponent(githubUsername)}/repos?type=public&sort=updated&per_page=100`,
    { headers: getGithubHeaders(token) },
  );


  if (!response.ok) {
    return res
      .status(response.status)
      .json({ message: `Unable to load repositories (${response.status})` });
  }

  const items = await response.json();
  const repos = Array.isArray(items)
    ? items.map((item) => String(item?.full_name ?? "").trim()).filter(Boolean)
    : [];


  return res.json({ items: repos });
});

export default router;
