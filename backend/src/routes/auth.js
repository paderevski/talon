import { Router } from "express";
import { getUsersRepository } from "../repositories/usersRepository.js";
import { publicUser } from "../auth/middleware.js";
import { sessionCookieName } from "../auth/session.js";
import { clearFailures, lockedSeconds, recordFailure } from "../auth/loginThrottle.js";

const router = Router();
const usersRepository = await getUsersRepository();

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

// publicUser plus the user's remaining personal budget, in dollars.
async function publicUserWithBudget(user) {
  return {
    ...publicUser(user),
    budgetBalance: (await usersRepository.getPersonalBalanceDollars?.(user.id)) ?? 0,
  };
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
    const waitSeconds = await lockedSeconds(username);
    if (waitSeconds > 0) {
      res.set("Retry-After", String(waitSeconds));
      return res.status(429).json({
        message: `Too many failed attempts. Try again in ${Math.ceil(waitSeconds / 60)} minute(s).`,
        retryAfterSeconds: waitSeconds,
      });
    }

    const matched = await usersRepository.findByCredentials(username, password);

    if (!matched) {
      await recordFailure(username);
      return res.status(401).json({ message: "Invalid username or password" });
    }

    await clearFailures(username);

    // New session id on login (prevents session fixation).
    await regenerateSession(req);
    req.session.userId = matched.id;
    await saveSession(req);
    await usersRepository.recordLogin?.(matched.id);

    return res.json({ ok: true, user: await publicUserWithBudget(matched) });
  } catch {
    return res.status(500).json({ message: "Unable to validate credentials" });
  }
});

router.post("/logout", (req, res) => {
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

export default router;
