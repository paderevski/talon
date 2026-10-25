import { Router } from "express";
import { getUsersRepository } from "../repositories/usersRepository.js";

const router = Router();
const usersRepository = await getUsersRepository();

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

    return res.json({
      ok: true,
      user: {
        username: matched.username,
        fullName: matched.fullName,
        role: matched.role,
      },
    });
  } catch {
    return res.status(500).json({ message: "Unable to validate credentials" });
  }
});

export default router;
