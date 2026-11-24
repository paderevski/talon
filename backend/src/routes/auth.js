import { Router } from "express";
import { getUsersRepository } from "../repositories/usersRepository.js";
import { publicUser } from "../auth/middleware.js";
import { sessionCookieName } from "../auth/session.js";
import {
  clearLoginAttempts,
  clearPasswordAttempts,
  reserveLoginAttempt,
  reservePasswordAttempt,
} from "../auth/loginThrottle.js";
import { changeOwnPassword, sendManagementError } from "../services/management.js";
import { createEntraClient } from "../auth/entra.js";
import { signInWithEntra } from "../services/entraSignIn.js";
import { log } from "../utils/log.js";

const router = Router();
const usersRepository = await getUsersRepository();
const entra = createEntraClient();

// Back to the login page with a code it explains (?signin=<code>).
const backToLogin = (res, code) => res.redirect(303, `/?signin=${encodeURIComponent(code)}`);

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((error) => (error ? reject(error) : resolve()));
  });
}

// Fields for login events. The attempted username is capped: people sometimes
// type a password into the username box.
function loginFields(req, username) {
  return { requestId: req.id, username: String(username).slice(0, 64), ip: req.ip };
}

// publicUser plus the user's remaining personal budget, in dollars.
async function publicUserWithBudget(user) {
  return {
    ...publicUser(user),
    budgetBalance: (await usersRepository.getPersonalBalanceDollars?.(user.id)) ?? 0,
  };
}

function sendThrottled(res, event, message, { retryAfterSeconds }, fields) {
  log.warn(message, { event, ...fields });
  res.set("Retry-After", String(retryAfterSeconds));
  return res.status(429).json({
    message: `Too many failed attempts. Try again in ${Math.ceil(retryAfterSeconds / 60)} minute(s).`,
    retryAfterSeconds,
  });
}

router.post("/login", async (req, res) => {
  const username = String(req.body?.username ?? "").trim();
  const password = String(req.body?.password ?? "").trim();

  if (!username || !password) {
    return res
      .status(400)
      .json({ message: "Username and password are required" });
  }

  try {
    // Count this attempt first (atomically); only a reserved attempt gets to
    // check the password.
    const reservation = await reserveLoginAttempt(username, req.ip);
    if (!reservation.allowed) {
      return sendThrottled(res, "auth.login_locked", "login refused: too many attempts", reservation, loginFields(req, username));
    }

    const matched = await usersRepository.findByCredentials(username, password);

    if (!matched) {
      log.warn("login failed", { event: "auth.login_failed", ...loginFields(req, username) });
      return res.status(401).json({ message: "Invalid username or password" });
    }

    await clearLoginAttempts(username, req.ip);

    // New session id on login (prevents session fixation).
    await regenerateSession(req);
    req.session.userId = matched.id;
    await saveSession(req);
    await usersRepository.recordLogin?.(matched.id);
    log.info("login", { event: "auth.login", ...loginFields(req, matched.username), userId: matched.id });

    return res.json({ ok: true, user: await publicUserWithBudget(matched) });
  } catch (error) {
    log.error("login error", { event: "auth.login_error", ...loginFields(req, username), err: error });
    return res.status(500).json({ message: "Unable to validate credentials" });
  }
});

// What the login page offers. Unauthenticated, so booleans only.
router.get("/options", async (_req, res) => {
  res.json({ entra: (await entra.status()).configured });
});

// Sign in with Microsoft (auth/entra.js). Both are browser navigations:
// they answer with redirects, never JSON.
router.get("/entra/login", async (req, res) => {
  try {
    const { url, pending } = await entra.beginLogin({ host: req.get("host") });
    req.session.entraLogin = pending;
    await saveSession(req);
    return res.redirect(303, url);
  } catch (error) {
    if (error.code === "not-configured") {
      return backToLogin(res, "not-configured");
    }
    log.error("Microsoft sign-in could not start", { event: "auth.entra_error", requestId: req.id, ip: req.ip, err: error });
    return backToLogin(res, "failed");
  }
});

router.get("/entra/callback", async (req, res) => {
  const pending = req.session?.entraLogin;
  if (req.session) {
    delete req.session.entraLogin; // one use only
  }
  const fields = { requestId: req.id, ip: req.ip };
  let identity;
  try {
    identity = await entra.finishLogin(pending, req.query);
    const { userId, outcome } = await signInWithEntra(identity, identity.policy);

    // New session id on login (prevents session fixation).
    await regenerateSession(req);
    req.session.userId = userId;
    await saveSession(req);
    const user = await usersRepository.findById(userId);
    log.info("login", { event: "auth.login", ...fields, provider: "entra", outcome, username: user?.username, userId });
    return res.redirect(303, "/");
  } catch (error) {
    const code = error.code && /^[a-z-]+$/.test(error.code) ? error.code : "failed";
    const level = code === "failed" ? "error" : "warn";
    log[level]("Microsoft sign-in refused", {
      event: code === "failed" ? "auth.entra_error" : "auth.entra_refused",
      ...fields,
      reason: code,
      detail: error.message,
      // Who tried (no tokens): the Microsoft object id and email, when known
      // (emailVerified false: the address is the token's claim, not trusted).
      ...(identity ? {
        oid: identity.oid,
        username: identity.email || identity.claimedEmail,
        emailVerified: Boolean(identity.email),
      } : {}),
    });
    return backToLogin(res, code);
  }
});

router.post("/logout", (req, res) => {
  if (req.user) {
    log.info("logout", { event: "auth.logout", requestId: req.id, userId: req.user.id });
  }
  req.session.destroy(() => {
    res.clearCookie(sessionCookieName);
    res.json({ ok: true });
  });
});

router.get("/me", async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: "Not signed in" });
  }

  return res.json({ ok: true, user: await publicUserWithBudget(req.user) });
});

router.post("/password", async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: "Not signed in" });
  }

  try {
    const reservation = await reservePasswordAttempt(req.user.username);
    if (!reservation.allowed) {
      return sendThrottled(res, "auth.password_locked", "password change refused: too many attempts", reservation, {
        requestId: req.id,
        userId: req.user.id,
      });
    }
    await changeOwnPassword(
      req.user.id,
      String(req.body?.currentPassword ?? ""),
      String(req.body?.newPassword ?? ""),
      req.sessionID,
    );
    await clearPasswordAttempts(req.user.username);
    log.info("password changed", { event: "auth.password_changed", requestId: req.id, userId: req.user.id });
    return res.json({ ok: true });
  } catch (error) {
    return sendManagementError(error, res, next);
  }
});

export default router;
