import { Router } from "express";
import {
  deleteGithubTokenForUser,
  getGithubTokenForUser,
  getGithubTokenStatusForUser,
  saveGithubTokenForUser,
} from "../utils/githubCredentialsStore.js";

const router = Router();

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

router.get("/", async (req, res) => {
  const talonUser = getTalonUserFromRequest(req);

  if (!talonUser) {
    return res.json({ hasToken: false, tokenLast4: "", updatedAt: null });
  }

  const status = await getGithubTokenStatusForUser(talonUser);
  return res.json(status);
});

router.put("/", async (req, res) => {
  const talonUser = getTalonUserFromRequest(req);
  const token = String(req.body?.token ?? "").trim();

  if (!talonUser) {
    return res.status(400).json({ message: "Missing x-talon-user header" });
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

  await saveGithubTokenForUser(talonUser, token);
  const status = await getGithubTokenStatusForUser(talonUser);
  return res.json({ ok: true, status });
});

router.delete("/", async (req, res) => {
  const talonUser = getTalonUserFromRequest(req);

  if (!talonUser) {
    return res.status(400).json({ message: "Missing x-talon-user header" });
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
