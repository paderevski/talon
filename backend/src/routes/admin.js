import { Router } from "express";
import { getUsersRepository } from "../repositories/usersRepository.js";

const router = Router();
const usersRepository = await getUsersRepository();

function getTalonUserFromRequest(req) {
  return String(req.get("x-talon-user") ?? "").trim();
}

router.get("/roster", async (req, res) => {
  const talonUser = getTalonUserFromRequest(req);

  if (!talonUser) {
    return res.status(400).json({ message: "Missing x-talon-user header" });
  }

  const requestingUser = await usersRepository.findByUsername(talonUser);
  if (!requestingUser) {
    return res.status(404).json({ message: "Requesting user was not found" });
  }

  if (!(requestingUser.roles ?? [requestingUser.role]).includes("admin")) {
    return res.status(403).json({ message: "Admin access is required" });
  }

  const roster = await usersRepository.listAdminRoster();
  return res.json({
    ok: true,
    roster,
  });
});

export default router;
