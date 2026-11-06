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

// Moves dollars between the teacher's pool and a student in one of their
// classes: direction "give" (default) or "take".
router.post("/allocations", async (req, res, next) => {
  try {
    const { studentUsername, amount, note, direction } = req.body ?? {};
    await allocateToStudent({ teacher: req.user, studentUsername, amount, note, direction });
    return res.status(201).json({ ok: true });
  } catch (error) {
    return sendManagementError(error, res, next);
  }
});

export default router;
