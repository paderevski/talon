import { Router } from "express";
import { getUsersRepository } from "../repositories/usersRepository.js";
import { publicUser } from "../auth/middleware.js";
import { sessionCookieName } from "../auth/session.js";

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

router.post("/login", async (req, res) => {
  const username = String(req.body?.username ?? "").trim();
  const password = String(req.body?.password ?? "").trim();

  if (!username || !password) {
    return res
      .status(400)
      .json({ message: "Username and password are required" });
  }

  try {
    const matched = await usersRepository.findByCredentials(username, password);

    if (!matched) {
      return res.status(401).json({ message: "Invalid username or password" });
    }

    // New session id on login (prevents session fixation).
    await regenerateSession(req);
    req.session.userId = matched.id;
    await saveSession(req);
    await usersRepository.recordLogin?.(matched.id);

    return res.json({ ok: true, user: publicUser(matched) });
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

router.get("/me", (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: "Not signed in" });
  }

  return res.json({ ok: true, user: publicUser(req.user) });
});

export default router;
