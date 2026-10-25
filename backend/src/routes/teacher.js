import { Router } from "express";
import { getUsersRepository } from "../repositories/usersRepository.js";

// Mounted behind requireRole("teacher") in server.js.
const router = Router();
const usersRepository = await getUsersRepository();

router.get("/students", async (req, res) => {
  const roster = await usersRepository.getTeacherRoster(req.user.username);
  return res.json({
    ok: true,
    roster,
  });
});

export default router;
