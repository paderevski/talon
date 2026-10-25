import { Router } from "express";
import { getUsersRepository } from "../repositories/usersRepository.js";
import { allocateToStudent, sendManagementError } from "../services/management.js";

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

// Moves dollars from the teacher's pool to a student in one of their classes.
router.post("/allocations", async (req, res, next) => {
  try {
    const { studentUsername, amount, note } = req.body ?? {};
    await allocateToStudent({ teacher: req.user, studentUsername, amount, note });
    return res.status(201).json({ ok: true });
  } catch (error) {
    return sendManagementError(error, res, next);
  }
});

export default router;
