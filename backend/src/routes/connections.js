import { randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { describeProvider, getConnectionRegistry } from "../connections/registry.js";
import { log } from "../utils/log.js";

// Linked outside accounts (connections/registry.js). For each provider:
//   GET    /api/connections                       [{ provider, label, auth, roles, configured, linked, account, needsReconnect }]
//   GET    /api/connections/:provider             one of the above
//   GET    /api/connections/:provider/connect     redirect to the provider (?mode=...)
//   GET    /api/connections/:provider/callback    the provider redirects here; links the account
//   GET    /api/connections/:provider/items       { items: [{ id, label, private }] }
//   DELETE /api/connections/:provider             unlink
// A provider with a mountPath (GitHub: /api/github) answers there too.
//
// The OAuth round trip is browser navigations only (no webhooks), so it
// works through the SSM tunnel too.

const stateMaxAgeMs = 10 * 60 * 1000;

// Back to the app with a result code the Connections panel turns into a message.
const backToApp = (res, provider, result) =>
  res.redirect(303, `/?connection=${encodeURIComponent(provider)}&result=${encodeURIComponent(result)}#connections`);

// The routes for one provider, mounted at /api/connections/<id> and at its
// mountPath. Each route checks sign-in itself: the callback must redirect,
// never answer 401.
export function createProviderRouter(provider) {
  const router = Router();

  router.get("/", requireAuth, async (req, res) => res.json(await describeProvider(provider, req.user.id)));

  router.get("/connect", requireAuth, async (req, res) => {
    const { configured } = await provider.status();
    if (!configured) {
      return backToApp(res, provider.id, "not-configured");
    }
    const state = randomBytes(24).toString("base64url");
    req.session.connectionOAuth = { provider: provider.id, state, at: Date.now() };
    const mode = provider.modes?.includes(req.query.mode) ? req.query.mode : provider.modes?.[0];
    const url = await provider.authorizeUrl(state, mode);
    return req.session.save((error) =>
      error ? res.status(500).json({ message: `Could not start ${provider.label} sign-in` }) : res.redirect(303, url));
  });

  // Reached by a top-level navigation from the provider, so the (SameSite=Lax)
  // session cookie is sent. Answers with redirects, never JSON.
  router.get("/callback", async (req, res) => {
    if (!req.user) {
      return backToApp(res, provider.id, "signed-out");
    }
    const expected = req.session?.connectionOAuth;
    delete req.session.connectionOAuth; // one use only
    const got = Buffer.from(String(req.query.state ?? ""));
    const want = Buffer.from(String(expected?.state ?? ""));
    if (
      expected?.provider !== provider.id
      || !want.length || got.length !== want.length || !timingSafeEqual(got, want)
      || Date.now() - expected.at > stateMaxAgeMs
    ) {
      return backToApp(res, provider.id, "state");
    }
    if (req.query.error) {
      return backToApp(res, provider.id, "denied");
    }
    try {
      return backToApp(res, provider.id, await provider.completeCallback(req.user.id, req.query));
    } catch (error) {
      log.warn(`${provider.label} linking failed`, {
        event: "connection.link_failed", provider: provider.id, requestId: req.id, userId: req.user.id, error: error.message,
      });
      return backToApp(res, provider.id, "failed");
    }
  });

  router.get("/items", requireAuth, async (req, res) => {
    try {
      return res.json({ items: await provider.listItems(req.user.id) });
    } catch (error) {
      return res.status(error.status || 500).json({ message: error.status ? error.message : `Could not list what ${provider.label} shares` });
    }
  });

  router.delete("/", requireAuth, async (req, res) => {
    await provider.unlink(req.user.id);
    return res.json({ ok: true });
  });

  provider.extendRouter?.(router, { requireAuth });
  return router;
}

// Mounts everything: /api/connections (list + per provider) and each
// provider's own mountPath. Call with the express app.
export function mountConnectionRoutes(app, registry = getConnectionRegistry()) {
  const list = Router();
  list.get("/", requireAuth, async (req, res) => res.json({ items: await registry.describeFor(req.user.id) }));
  app.use("/api/connections", list);
  for (const provider of registry.list()) {
    const router = createProviderRouter(provider);
    app.use(`/api/connections/${provider.id}`, router);
    if (provider.mountPath) {
      app.use(provider.mountPath, router);
    }
  }
}
