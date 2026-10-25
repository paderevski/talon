import { Router } from "express";
import { getUsersRepository } from "../repositories/usersRepository.js";

const router = Router();
const usersRepository = await getUsersRepository();

function getTalonUserFromRequest(req) {
  return String(req.get("x-talon-user") ?? "").trim();
}

router.get("/students", async (req, res) => {
  const talonUser = getTalonUserFromRequest(req);

  if (!talonUser) {
    return res.status(400).json({ message: "Missing x-talon-user header" });
  }

  const requestingUser = await usersRepository.findByUsername(talonUser);
  if (!requestingUser) {
    return res.status(404).json({ message: "Requesting user was not found" });
  }

  if (requestingUser.role !== "teacher") {
    return res.status(403).json({ message: "Teacher access is required" });
  }

  const roster = await usersRepository.getTeacherRoster(talonUser);
  return res.json({
    ok: true,
    roster,
  });
});

export default router;
