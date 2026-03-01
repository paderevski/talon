import { Router } from "express";
import {
  deleteGithubTokenForUser,
  getGithubTokenForUser,
  getGithubTokenStatusForUser,
  saveGithubUsernameForUser,
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
  console.info(
    `[github-credentials] GET /api/github-credentials received (talonUser='${talonUser || "(missing)"}')`,
  );

  if (!talonUser) {
    console.info(
      "[github-credentials] responding with hasToken=false because x-talon-user is missing",
    );
    return res.json({
      hasToken: false,
      tokenLast4: "",
      githubUsername: "",
      updatedAt: null,
    });
  }

  const status = await getGithubTokenStatusForUser(talonUser);
  console.info(
    `[github-credentials] sending status response (hasToken=${Boolean(status?.hasToken)}) for talonUser='${talonUser}'`,
  );
  return res.json(status);
});

router.put("/", async (req, res) => {
  const talonUser = getTalonUserFromRequest(req);
  const token = String(req.body?.token ?? "").trim();
  const githubUsername = String(req.body?.githubUsername ?? "").trim();
  console.info(
    `[github-credentials] PUT /api/github-credentials received (talonUser='${talonUser || "(missing)"}', tokenProvided=${Boolean(token)}, githubUsernameProvided=${Boolean(githubUsername)})`,
  );

  if (!talonUser) {
    return res.status(400).json({ message: "Missing x-talon-user header" });
  }

  if (!token) {
    return res.status(400).json({ message: "Token is required" });
  }

  const testResponse = await fetch("https://api.github.com/user", {
    headers: getGithubHeaders(token),
  });

  console.info(
    `[github-credentials] GitHub token validation response status=${testResponse.status}`,
  );

  if (!testResponse.ok) {
    return res.status(400).json({ message: "Invalid GitHub token" });
  }

  await saveGithubTokenForUser(talonUser, token, githubUsername);
  const status = await getGithubTokenStatusForUser(talonUser);
  console.info(
    `[github-credentials] token saved and status returned (hasToken=${Boolean(status?.hasToken)}) for talonUser='${talonUser}'`,
  );
  return res.json({ ok: true, status });
});

router.patch("/", async (req, res) => {
  const talonUser = getTalonUserFromRequest(req);
  const githubUsername = String(req.body?.githubUsername ?? "").trim();
  console.info(
    `[github-credentials] PATCH /api/github-credentials received (talonUser='${talonUser || "(missing)"}', githubUsernameProvided=${Boolean(githubUsername)})`,
  );

  if (!talonUser) {
    return res.status(400).json({ message: "Missing x-talon-user header" });
  }

  await saveGithubUsernameForUser(talonUser, githubUsername);
  const status = await getGithubTokenStatusForUser(talonUser);
  console.info(
    `[github-credentials] github username saved and status returned (hasToken=${Boolean(status?.hasToken)}, githubUsername='${String(status?.githubUsername ?? "")}') for talonUser='${talonUser}'`,
  );
  return res.json({ ok: true, status });
});

router.delete("/", async (req, res) => {
  const talonUser = getTalonUserFromRequest(req);
  console.info(
    `[github-credentials] DELETE /api/github-credentials received (talonUser='${talonUser || "(missing)"}')`,
  );

  if (!talonUser) {
    return res.status(400).json({ message: "Missing x-talon-user header" });
  }

  await deleteGithubTokenForUser(talonUser);
  console.info(
    `[github-credentials] token deleted for talonUser='${talonUser}'`,
  );
  return res.json({ ok: true });
});

router.get("/repos/:username", async (req, res) => {
  const githubUsername = String(req.params.username ?? "").trim();
  const talonUser = getTalonUserFromRequest(req);
  console.info(
    `[github-credentials] GET /api/github-credentials/repos/:username received (talonUser='${talonUser || "(missing)"}', githubUsername='${githubUsername || "(missing)"}')`,
  );

  if (!githubUsername) {
    return res.status(400).json({ message: "GitHub username is required" });
  }

  const token = talonUser ? await getGithubTokenForUser(talonUser) : "";
  const response = await fetch(
    `https://api.github.com/users/${encodeURIComponent(githubUsername)}/repos?type=public&sort=updated&per_page=100`,
    { headers: getGithubHeaders(token) },
  );

  console.info(
    `[github-credentials] GitHub repos response status=${response.status} (authHeaderUsed=${Boolean(token)})`,
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

  console.info(
    `[github-credentials] sending repos response count=${repos.length} for githubUsername='${githubUsername}'`,
  );

  return res.json({ items: repos });
});

export default router;
