import { Router } from "express";
import { getUsersRepository } from "../repositories/usersRepository.js";
import {
  addClassMember,
  createClass,
  createUser,
  grantBudget,
  listClasses,
  listUsers,
  removeClassMember,
  resetPassword,
  sendManagementError,
  unlockUser,
  updateClass,
  updateUser,
} from "../services/management.js";

// Mounted behind requireRole("admin") in server.js.
const router = Router();
const usersRepository = await getUsersRepository();

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Runs a handler; service errors become 4xx JSON, the rest reach the
// generic error handler. Rejects malformed :userId / :classId first.
function handle(fn) {
  return async (req, res, next) => {
    try {
      const { userId, classId } = req.params;
      if (userId !== undefined && !uuidPattern.test(userId)) {
        return res.status(404).json({ message: "User not found" });
      }
      if (classId !== undefined && !/^\d{1,15}$/.test(classId)) {
        return res.status(404).json({ message: "Class not found" });
      }
      return await fn(req, res);
    } catch (error) {
      return sendManagementError(error, res, next);
    }
  };
}

router.get("/roster", async (_req, res) => {
  const roster = await usersRepository.listAdminRoster();
  return res.json({
    ok: true,
    roster,
  });
});

router.get("/users", handle(async (_req, res) => {
  return res.json({ ok: true, users: await listUsers() });
}));

// The generated password is in the response once and is not stored anywhere readable.
router.post("/users", handle(async (req, res) => {
  const created = await createUser(req.body, req.user.id);
  return res.status(201).json({ ok: true, ...created });
}));

router.patch("/users/:userId", handle(async (req, res) => {
  await updateUser(req.params.userId, req.body ?? {}, req.user);
  return res.json({ ok: true });
}));

router.post("/users/:userId/reset-password", handle(async (req, res) => {
  const keepSid = req.params.userId === req.user.id ? req.sessionID : "";
  return res.json({ ok: true, ...(await resetPassword(req.params.userId, keepSid)) });
}));

router.post("/users/:userId/unlock", handle(async (req, res) => {
  await unlockUser(req.params.userId);
  return res.json({ ok: true });
}));

router.get("/classes", handle(async (req, res) => {
  const classes = await listClasses({ includeArchived: req.query.includeArchived === "1" });
  return res.json({ ok: true, classes });
}));

router.post("/classes", handle(async (req, res) => {
  const id = await createClass(req.body ?? {});
  return res.status(201).json({ ok: true, id });
}));

router.patch("/classes/:classId", handle(async (req, res) => {
  await updateClass(Number(req.params.classId), req.body ?? {});
  return res.json({ ok: true });
}));

router.post("/classes/:classId/members", handle(async (req, res) => {
  const { userId, memberRole } = req.body ?? {};
  if (!uuidPattern.test(String(userId ?? ""))) {
    return res.status(400).json({ message: "Choose a user to add" });
  }
  await addClassMember(Number(req.params.classId), userId, memberRole);
  return res.status(201).json({ ok: true });
}));

router.delete("/classes/:classId/members/:userId", handle(async (req, res) => {
  await removeClassMember(Number(req.params.classId), req.params.userId);
  return res.json({ ok: true });
}));

router.post("/budget/grants", handle(async (req, res) => {
  const { userId, target, amount, note } = req.body ?? {};
  if (!uuidPattern.test(String(userId ?? ""))) {
    return res.status(400).json({ message: "Choose a user" });
  }
  await grantBudget({ userId, target, amount, note }, req.user.id);
  return res.status(201).json({ ok: true });
}));

export default router;
