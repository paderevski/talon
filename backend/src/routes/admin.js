import { Router } from "express";
import { getUsersRepository } from "../repositories/usersRepository.js";
import {
  addClassMember,
  createClass,
  createUser,
  adjustBudget,
  listClasses,
  listUsers,
  removeClassMember,
  resetPassword,
  sendManagementError,
  unlockUser,
  updateClass,
  updateUser,
} from "../services/management.js";
import { importRoster } from "../services/rosterImport.js";
import { getConnectionRegistry } from "../connections/registry.js";
import { log } from "../utils/log.js";

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
      // Postgres matches a uuid in any case, but the self checks and session
      // revocation compare text: use the canonical lower-case form.
      if (userId !== undefined) {
        req.params.userId = userId.toLowerCase();
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

// Unlinks one of the user's outside accounts (same as their own Disconnect:
// for GitHub, Talon's grant is revoked on GitHub too), e.g. when a student
// linked the wrong account. They can connect again afterwards.
router.delete("/users/:userId/connections/:provider", handle(async (req, res) => {
  const provider = getConnectionRegistry().get(req.params.provider);
  if (!provider) {
    return res.status(404).json({ message: "Unknown connection" });
  }
  const link = await provider.getLink(req.params.userId);
  if (!link) {
    return res.status(404).json({ message: `This user has no ${provider.label} account linked` });
  }
  await provider.unlink(req.params.userId);
  log.info(`admin ${req.user.username} unlinked ${provider.label} account ${link.login}`, {
    event: "admin.connection_unlinked",
    requestId: req.id,
    userId: req.user.id,
    targetUserId: req.params.userId,
    provider: provider.id,
    login: link.login,
  });
  return res.json({ ok: true, provider: provider.id, login: link.login });
}));

// CSV roster import. { csv, defaultRole, dryRun }; dryRun defaults to true so
// nothing is written unless the caller says dryRun: false.
router.post("/import", handle(async (req, res) => {
  const { csv, defaultRole, dryRun } = req.body ?? {};
  const result = await importRoster(
    { csv: String(csv ?? ""), defaultRole: defaultRole || "student", dryRun: dryRun !== false },
    req.user.id,
  );
  return res.status(result.dryRun ? 200 : 201).json({ ok: true, ...result });
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

router.post("/budget/adjustments", handle(async (req, res) => {
  const { userId, target, direction, amount, note } = req.body ?? {};
  if (!uuidPattern.test(String(userId ?? ""))) {
    return res.status(400).json({ message: "Choose a user" });
  }
  await adjustBudget({ userId, target, direction, amount, note }, req.user.id);
  return res.status(201).json({ ok: true });
}));

export default router;
