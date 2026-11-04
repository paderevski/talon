import { randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { getGithubApp } from "../services/githubApp.js";
import { GithubAccountInUseError } from "../utils/githubAccountsStore.js";
import { log } from "../utils/log.js";

// "Connect GitHub" (GitHub App user sign-in). The browser is sent to GitHub
// and comes back to /callback; nothing on GitHub calls Talon (no webhooks),
// so this works through the SSM tunnel too.
//   GET    /api/github            { configured, linked, login, linkedAt }
//   GET    /api/github/connect    redirect to GitHub (?mode=install to pick repos)
//   GET    /api/github/callback   GitHub redirects here; links the account
//   GET    /api/github/repos      { items: [{ fullName, private }] }
//   DELETE /api/github            unlink
export function createGithubRouter({ app = null } = {}) {
  const router = Router();
  const github = () => app ?? getGithubApp();
  const stateMaxAgeMs = 10 * 60 * 1000;

  // Back to the app with a result code the GitHub panel turns into a message.
  const backToApp = (res, result) => res.redirect(303, `/?github=${encodeURIComponent(result)}#github`);

  router.get("/", requireAuth, async (req, res) => {
    const { configured } = await github().status();
    const link = configured ? await github().getLink(req.user.id) : null;
    return res.json({
      configured,
      linked: Boolean(link),
      login: link?.githubLogin ?? "",
      linkedAt: link?.linkedAt ?? null,
    });
  });

  router.get("/connect", requireAuth, async (req, res) => {
    const { configured } = await github().status();
    if (!configured) {
      return backToApp(res, "not-configured");
    }
    const state = randomBytes(24).toString("base64url");
    req.session.githubOAuth = { state, at: Date.now() };
    const mode = req.query.mode === "install" ? "install" : "authorize";
    const url = await github().authorizeUrl(state, mode);
    return req.session.save((error) => (error ? res.status(500).json({ message: "Could not start GitHub sign-in" }) : res.redirect(303, url)));
  });

  // Reached by a top-level navigation from github.com, so the (SameSite=Lax)
  // session cookie is sent. Answers with redirects, never JSON.
  router.get("/callback", async (req, res) => {
    if (!req.user) {
      return backToApp(res, "signed-out");
    }
    const expected = req.session?.githubOAuth;
    delete req.session.githubOAuth; // one use only
    const got = Buffer.from(String(req.query.state ?? ""));
    const want = Buffer.from(String(expected?.state ?? ""));
    if (!want.length || got.length !== want.length || !timingSafeEqual(got, want) || Date.now() - expected.at > stateMaxAgeMs) {
      return backToApp(res, "state");
    }
    if (req.query.error) {
      return backToApp(res, "denied");
    }
    const code = String(req.query.code ?? "");
    if (!code) {
      // e.g. repositories changed on an existing install without a new sign-in
      return backToApp(res, req.query.installation_id ? "updated" : "denied");
    }
    try {
      await github().completeLink(req.user.id, code);
      return backToApp(res, "connected");
    } catch (error) {
      if (error instanceof GithubAccountInUseError) {
        return backToApp(res, "in-use");
      }
      log.warn("GitHub linking failed", { event: "github.link_failed", requestId: req.id, userId: req.user.id, error: error.message });
      return backToApp(res, "failed");
    }
  });

  router.get("/repos", requireAuth, async (req, res) => {
    try {
      return res.json({ items: await github().listRepos(req.user.id) });
    } catch (error) {
      return res.status(error.status || 500).json({ message: error.status ? error.message : "Could not list repositories" });
    }
  });

  router.delete("/", requireAuth, async (req, res) => {
    await github().unlink(req.user.id);
    return res.json({ ok: true });
  });

  return router;
}

export default createGithubRouter();
