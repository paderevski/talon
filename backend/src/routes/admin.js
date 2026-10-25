import { Router } from "express";
import { getUsersRepository } from "../repositories/usersRepository.js";

// Mounted behind requireRole("admin") in server.js.
const router = Router();
const usersRepository = await getUsersRepository();

router.get("/roster", async (_req, res) => {
  const roster = await usersRepository.listAdminRoster();
  return res.json({
    ok: true,
    roster,
  });
});

export default router;
