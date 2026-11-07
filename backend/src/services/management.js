import { randomBytes } from "node:crypto";
import { getPool, withTransaction } from "../db/pool.js";
import {
  BudgetError,
  adjust,
  centsToDollars,
  dollarsToCents,
  ensureAccount,
  grant,
  transfer,
} from "../budget/ledger.js";
import { createPasswordHash, verifyPassword } from "../utils/passwords.js";
import { clearFailures } from "../auth/loginThrottle.js";

// Admin and teacher operations: users, classes, class membership, budgets.
// Everything that changes more than one row runs in one transaction.

export class ManagementError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "ManagementError";
    this.status = status;
  }
}

export const allRoles = ["student", "teacher", "admin"];
const maxGrantCents = 100_000_00; // $100,000 per action, a typo guard

export function generatePassword() {
  return randomBytes(12).toString("base64url");
}

export function cleanText(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

export function cleanRoles(roles) {
  const list = [...new Set((Array.isArray(roles) ? roles : []).map((role) => String(role)))];
  if (list.length === 0 || list.some((role) => !allRoles.includes(role))) {
    throw new ManagementError("Choose at least one role: student, teacher or admin");
  }
  return list;
}

export function cleanUsername(value) {
  const username = cleanText(value, 100);
  if (!/^[A-Za-z0-9._@+-]{3,100}$/.test(username)) {
    throw new ManagementError(
      "Username must be 3-100 characters: letters, numbers and . _ @ + -",
    );
  }
  return username;
}

export function cleanEmail(value) {
  const email = cleanText(value, 200);
  if (!email) {
    return null;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ManagementError("Email address is not valid");
  }
  return email;
}

export function toCents(dollars) {
  const cents = dollarsToCents(dollars);
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > maxGrantCents) {
    throw new ManagementError("Amount must be more than $0 and at most $100,000");
  }
  return cents;
}

const formatCents = (cents) => `$${(cents / 100).toFixed(2)}`;

function uniqueViolation(error, message) {
  if (error?.code === "23505") {
    throw new ManagementError(message, 409);
  }
  throw error;
}

export async function setRoles(client, userId, roles, grantedBy) {
  await client.query(
    "DELETE FROM user_roles WHERE user_id = $1 AND NOT (role::text = ANY($2::text[]))",
    [userId, roles],
  );
  for (const role of roles) {
    await client.query(
      `INSERT INTO user_roles (user_id, role, granted_by) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [userId, role, grantedBy],
    );
  }
  await ensureAccount(client, userId, "personal");
  if (roles.includes("teacher")) {
    await ensureAccount(client, userId, "teacher_pool");
  }
}

// Signs a user out everywhere, optionally keeping one session (keepSid).
async function revokeSessions(client, userId, keepSid = "") {
  await client.query("DELETE FROM sessions WHERE sess->>'userId' = $1 AND sid <> $2", [
    userId,
    keepSid,
  ]);
}

// ---- Users -------------------------------------------------------------

export async function listUsers({ pool = getPool() } = {}) {
  const result = await pool.query(`
    SELECT u.id, u.username, u.email, u.display_name, u.status, u.last_login_at,
           ARRAY(SELECT r.role::text FROM user_roles r WHERE r.user_id = u.id ORDER BY r.role) AS roles,
           personal.balance_cents AS personal_cents,
           pool.balance_cents AS pool_cents,
           COALESCE((
             SELECT json_agg(json_build_object('provider', k.provider, 'login', k.external_login) ORDER BY k.provider)
             FROM connections k WHERE k.user_id = u.id
           ), '[]'::json) AS connections,
           COALESCE((
             SELECT json_agg(json_build_object('id', c.id, 'name', c.name, 'block', c.block,
                                               'memberRole', CASE WHEN c.teacher_id = u.id THEN 'teacher' ELSE 'student' END)
                             ORDER BY lower(c.name), lower(c.block))
             FROM classes c
             WHERE c.archived_at IS NULL
               AND (c.teacher_id = u.id
                    OR EXISTS (SELECT 1 FROM class_members m WHERE m.class_id = c.id AND m.user_id = u.id))
           ), '[]'::json) AS classes
    FROM users u
    LEFT JOIN budget_accounts personal ON personal.owner_user_id = u.id AND personal.kind = 'personal'
    LEFT JOIN budget_accounts pool ON pool.owner_user_id = u.id AND pool.kind = 'teacher_pool'
    ORDER BY lower(u.display_name), lower(u.username)
  `);

  return result.rows.map((row) => ({
    id: row.id,
    username: row.username,
    email: row.email,
    fullName: row.display_name,
    status: row.status,
    roles: row.roles,
    lastLoginAt: row.last_login_at,
    // Linked outside accounts: [{ provider, login }]. githubLogin is kept for
    // the user list's search and the Unlink GitHub button.
    connections: row.connections,
    githubLogin: row.connections.find((c) => c.provider === "github")?.login ?? "",
    personalBalance: centsToDollars(row.personal_cents ?? 0),
    poolBalance: row.pool_cents === null ? null : centsToDollars(row.pool_cents),
    classes: row.classes,
  }));
}

// Returns { id, username, password }; the password is only known now.
export async function createUser(input, actorId) {
  const username = cleanUsername(input?.username);
  const fullName = cleanText(input?.fullName, 200) || username;
  const email = cleanEmail(input?.email);
  const roles = cleanRoles(input?.roles);
  const password = generatePassword();

  try {
    const id = await withTransaction(async (client) => {
      const inserted = await client.query(
        "INSERT INTO users (username, email, display_name) VALUES ($1, $2, $3) RETURNING id",
        [username, email, fullName],
      );
      const userId = inserted.rows[0].id;
      await setRoles(client, userId, roles, actorId);
      await client.query(
        `INSERT INTO user_identities (user_id, provider, subject, password_hash)
         VALUES ($1, 'local', lower($2), $3)`,
        [userId, username, createPasswordHash(password)],
      );
      return userId;
    });
    return { id, username, password };
  } catch (error) {
    return uniqueViolation(error, "That username or email is already in use");
  }
}

export async function updateUser(userId, input, actor) {
  try {
    return await withTransaction(async (client) => {
      const found = await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
      if (found.rows.length === 0) {
        throw new ManagementError("User not found", 404);
      }

      const isSelf = userId === actor.id;

      if (input.status !== undefined) {
        if (!["active", "disabled"].includes(input.status)) {
          throw new ManagementError("Status must be active or disabled");
        }
        if (isSelf && input.status === "disabled") {
          throw new ManagementError("You cannot disable your own account");
        }
        await client.query("UPDATE users SET status = $2, updated_at = now() WHERE id = $1", [
          userId,
          input.status,
        ]);
        if (input.status === "disabled") {
          await revokeSessions(client, userId);
        }
      }

      if (input.fullName !== undefined) {
        const fullName = cleanText(input.fullName, 200);
        if (!fullName) {
          throw new ManagementError("Name is required");
        }
        await client.query("UPDATE users SET display_name = $2, updated_at = now() WHERE id = $1", [
          userId,
          fullName,
        ]);
      }

      if (input.email !== undefined) {
        await client.query("UPDATE users SET email = $2, updated_at = now() WHERE id = $1", [
          userId,
          cleanEmail(input.email),
        ]);
      }

      if (input.roles !== undefined) {
        const roles = cleanRoles(input.roles);
        if (isSelf && !roles.includes("admin")) {
          throw new ManagementError("You cannot remove your own admin role");
        }
        for (const role of ["teacher", "student"]) {
          if (roles.includes(role)) {
            continue;
          }
          const memberships = await client.query(
            role === "teacher"
              ? "SELECT 1 FROM classes c WHERE c.teacher_id = $1 AND c.archived_at IS NULL LIMIT 1"
              : `SELECT 1 FROM class_members m JOIN classes c ON c.id = m.class_id AND c.archived_at IS NULL
                 WHERE m.user_id = $1 LIMIT 1`,
            [userId],
          );
          if (memberships.rows.length > 0) {
            throw new ManagementError(
              `Remove this user from their ${role} classes before removing the ${role} role`,
              409,
            );
          }
        }
        await setRoles(client, userId, roles, actor.id);
      }

      return userId;
    });
  } catch (error) {
    return uniqueViolation(error, "That email is already in use");
  }
}

// New random password; signs the user out everywhere and clears any lockout.
// An admin resetting their own password keeps the session they are using
// (keepSid), otherwise the page would sign out before showing the password.
export async function resetPassword(userId, keepSid = "") {
  const password = generatePassword();
  const username = await withTransaction(async (client) => {
    const found = await client.query("SELECT username FROM users WHERE id = $1 FOR UPDATE", [userId]);
    if (found.rows.length === 0) {
      throw new ManagementError("User not found", 404);
    }
    const name = found.rows[0].username;
    await client.query(
      `INSERT INTO user_identities (user_id, provider, subject, password_hash)
       VALUES ($1, 'local', lower($2), $3)
       ON CONFLICT (provider, subject) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
      [userId, name, createPasswordHash(password)],
    );
    await revokeSessions(client, userId, keepSid);
    return name;
  });
  await clearFailures(username);
  return { username, password };
}

export async function unlockUser(userId) {
  const result = await getPool().query("SELECT username FROM users WHERE id = $1", [userId]);
  if (result.rows.length === 0) {
    throw new ManagementError("User not found", 404);
  }
  await clearFailures(result.rows[0].username);
}

// Self-service. Other sessions of the same user are signed out; the caller's
// own session (keepSid) stays.
export async function changeOwnPassword(userId, currentPassword, newPassword, keepSid) {
  if (String(newPassword ?? "").length < 8) {
    throw new ManagementError("New password must be at least 8 characters");
  }

  await withTransaction(async (client) => {
    const identity = await client.query(
      "SELECT password_hash FROM user_identities WHERE user_id = $1 AND provider = 'local' FOR UPDATE",
      [userId],
    );
    if (identity.rows.length === 0 || !verifyPassword(currentPassword, identity.rows[0].password_hash)) {
      throw new ManagementError("Current password is incorrect", 403);
    }
    await client.query(
      "UPDATE user_identities SET password_hash = $2 WHERE user_id = $1 AND provider = 'local'",
      [userId, createPasswordHash(newPassword)],
    );
    await client.query("DELETE FROM sessions WHERE sess->>'userId' = $1 AND sid <> $2", [
      userId,
      keepSid ?? "",
    ]);
  });
}

// ---- Classes -----------------------------------------------------------
// A class is one section: course name + teacher + block, with its own
// student roster (class_members). The database enforces the scheduling rules
// (migration 009); violations surface as 409s via sendManagementError.

export async function listClasses({ includeArchived = false, pool = getPool() } = {}) {
  const [classes, members] = await Promise.all([
    pool.query(
      `SELECT c.id, c.name, c.term, c.block, c.archived_at,
              t.id AS teacher_id, t.username AS teacher_username, t.display_name AS teacher_name
       FROM classes c LEFT JOIN users t ON t.id = c.teacher_id
       ${includeArchived ? "" : "WHERE c.archived_at IS NULL"}
       ORDER BY lower(c.name), lower(c.block), lower(t.display_name), c.id`,
    ),
    pool.query(`
      SELECT m.class_id, u.id AS user_id, u.username, u.display_name, a.balance_cents
      FROM class_members m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN budget_accounts a ON a.owner_user_id = u.id AND a.kind = 'personal'
      ORDER BY lower(u.display_name), lower(u.username)
    `),
  ]);

  return classes.rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    term: row.term,
    block: row.block,
    archived: row.archived_at !== null,
    teacher: row.teacher_id
      ? { id: row.teacher_id, username: row.teacher_username, fullName: row.teacher_name }
      : null,
    students: members.rows
      .filter((member) => Number(member.class_id) === Number(row.id))
      .map((member) => ({
        id: member.user_id,
        username: member.username,
        fullName: member.display_name,
        balance: centsToDollars(member.balance_cents ?? 0),
      })),
  }));
}

async function assertUserHasRole(client, userId, role) {
  const result = await client.query(
    "SELECT 1 FROM user_roles WHERE user_id = $1 AND role = $2::user_role",
    [userId, role],
  );
  if (result.rows.length === 0) {
    throw new ManagementError(`That user does not have the ${role} role`, 409);
  }
}

async function assertTeacher(client, userId) {
  const user = await client.query("SELECT 1 FROM users WHERE id = $1", [userId]);
  if (user.rows.length === 0) {
    throw new ManagementError("User not found", 404);
  }
  await assertUserHasRole(client, userId, "teacher");
}

function cleanBlock(value) {
  return cleanText(value, 20);
}

export async function createClass(input) {
  const name = cleanText(input?.name, 200);
  if (!name) {
    throw new ManagementError("Class name is required");
  }
  const block = cleanBlock(input?.block);
  if (!block) {
    throw new ManagementError("Block is required");
  }
  const term = cleanText(input?.term, 50) || null;
  const teacherId = input?.teacherId || null;

  return withTransaction(async (client) => {
    if (teacherId) {
      await assertTeacher(client, teacherId);
    }
    const inserted = await client.query(
      "INSERT INTO classes (name, term, block, teacher_id) VALUES ($1, $2, $3, $4) RETURNING id",
      [name, term, block, teacherId],
    );
    return Number(inserted.rows[0].id);
  });
}

// Changes any of: name, term, block, teacherId (null = unassign), archived.
export async function updateClass(classId, input) {
  await withTransaction(async (client) => {
    const found = await client.query("SELECT id FROM classes WHERE id = $1 FOR UPDATE", [classId]);
    if (found.rows.length === 0) {
      throw new ManagementError("Class not found", 404);
    }

    if (input.name !== undefined) {
      const name = cleanText(input.name, 200);
      if (!name) {
        throw new ManagementError("Class name is required");
      }
      await client.query("UPDATE classes SET name = $2 WHERE id = $1", [classId, name]);
    }
    if (input.term !== undefined) {
      await client.query("UPDATE classes SET term = $2 WHERE id = $1", [classId, cleanText(input.term, 50) || null]);
    }
    if (input.block !== undefined) {
      const block = cleanBlock(input.block);
      if (!block) {
        throw new ManagementError("Block is required");
      }
      await client.query("UPDATE classes SET block = $2 WHERE id = $1", [classId, block]);
    }
    if (input.teacherId !== undefined) {
      if (input.teacherId) {
        await assertTeacher(client, input.teacherId);
      }
      await client.query("UPDATE classes SET teacher_id = $2 WHERE id = $1", [classId, input.teacherId || null]);
    }
    if (input.archived !== undefined) {
      await client.query(
        `UPDATE classes SET archived_at = ${input.archived ? "COALESCE(archived_at, now())" : "NULL"}
         WHERE id = $1`,
        [classId],
      );
    }
  });
}

// memberRole "student" enrols a student; "teacher" assigns the class's one
// teacher (409 if it already has a different one).
export async function addClassMember(classId, userId, memberRole) {
  if (!["teacher", "student"].includes(memberRole)) {
    throw new ManagementError("Member role must be teacher or student");
  }

  await withTransaction(async (client) => {
    const found = await client.query("SELECT archived_at, teacher_id FROM classes WHERE id = $1 FOR UPDATE", [classId]);
    if (found.rows.length === 0) {
      throw new ManagementError("Class not found", 404);
    }
    if (found.rows[0].archived_at) {
      throw new ManagementError("This class is archived", 409);
    }
    const user = await client.query("SELECT 1 FROM users WHERE id = $1", [userId]);
    if (user.rows.length === 0) {
      throw new ManagementError("User not found", 404);
    }
    await assertUserHasRole(client, userId, memberRole);

    if (memberRole === "teacher") {
      const current = found.rows[0].teacher_id;
      if (current && current !== userId) {
        throw new ManagementError("This class already has a teacher. Remove them first, or create another section.", 409);
      }
      await client.query("UPDATE classes SET teacher_id = $2 WHERE id = $1", [classId, userId]);
      return;
    }
    await client.query(
      "INSERT INTO class_members (class_id, user_id) VALUES ($1, $2) ON CONFLICT (class_id, user_id) DO NOTHING",
      [classId, userId],
    );
  });
}

// Removes a student from the roster, or unassigns the teacher.
export async function removeClassMember(classId, userId) {
  await withTransaction(async (client) => {
    await client.query("UPDATE classes SET teacher_id = NULL WHERE id = $1 AND teacher_id = $2", [classId, userId]);
    await client.query("DELETE FROM class_members WHERE class_id = $1 AND user_id = $2", [classId, userId]);
  });
}

// ---- Budgets -----------------------------------------------------------

// Admin changes a balance: to a teacher's pool, or anyone's personal budget.
// "increase" creates money (a grant); "decrease" removes it (never below $0).
export async function adjustBudget({ userId, target, direction, amount, note }, actorId) {
  if (!["pool", "personal"].includes(target)) {
    throw new ManagementError("Target must be pool or personal");
  }
  if (!["increase", "decrease"].includes(direction)) {
    throw new ManagementError("Direction must be increase or decrease");
  }
  const amountCents = toCents(amount);

  await withTransaction(async (client) => {
    const user = await client.query("SELECT 1 FROM users WHERE id = $1", [userId]);
    if (user.rows.length === 0) {
      throw new ManagementError("User not found", 404);
    }
    if (target === "pool") {
      await assertUserHasRole(client, userId, "teacher");
    }
    const accountId = await ensureAccount(
      client,
      userId,
      target === "pool" ? "teacher_pool" : "personal",
    );
    const fallbackNote = direction === "increase" ? "Admin grant" : "Admin adjustment";
    const entry = { accountId, note: cleanText(note, 200) || fallbackNote, createdBy: actorId };
    if (direction === "increase") {
      await grant(client, { ...entry, amountCents });
    } else {
      await adjust(client, { ...entry, amountCents: -amountCents });
    }
  });
}

// Teacher moves money between their pool and a student in one of their
// classes: "give" (pool -> student) or "take" (student -> pool). Taking is
// limited only by the student's balance (spent money and running jobs'
// reservations are gone); where the money came from does not matter.
export async function allocateToStudent({ teacher, studentUsername, amount, note, direction = "give" }) {
  if (!["give", "take"].includes(direction)) {
    throw new ManagementError("Direction must be give or take");
  }
  const amountCents = toCents(amount);

  await withTransaction(async (client) => {
    const student = await client.query(
      `SELECT s.id FROM users s
       JOIN class_members sm ON sm.user_id = s.id
       JOIN classes c ON c.id = sm.class_id AND c.archived_at IS NULL AND c.teacher_id = $2
       WHERE lower(s.username) = lower($1) AND s.status = 'active'
       LIMIT 1`,
      [cleanText(studentUsername, 100), teacher.id],
    );
    if (student.rows.length === 0) {
      throw new ManagementError("That student is not in one of your classes", 404);
    }

    const poolAccountId = await ensureAccount(client, teacher.id, "teacher_pool");
    const studentAccountId = await ensureAccount(client, student.rows[0].id, "personal");

    if (direction === "take") {
      try {
        await transfer(client, {
          fromAccountId: studentAccountId,
          toAccountId: poolAccountId,
          amountCents,
          note: cleanText(note, 200) || "Returned to teacher pool",
          createdBy: teacher.id,
        });
      } catch (error) {
        if (error instanceof BudgetError && error.code === "insufficient_funds") {
          const balance = await client.query("SELECT balance_cents FROM budget_accounts WHERE id = $1", [studentAccountId]);
          throw new ManagementError(
            `The student has only ${formatCents(Math.max(Number(balance.rows[0].balance_cents), 0))} left (spent money and running jobs' reservations can't be taken back)`,
            409,
          );
        }
        throw error;
      }
      return;
    }

    try {
      await transfer(client, {
        fromAccountId: poolAccountId,
        toAccountId: studentAccountId,
        amountCents,
        note: cleanText(note, 200) || "Teacher allocation",
        createdBy: teacher.id,
      });
    } catch (error) {
      if (error instanceof BudgetError && error.code === "insufficient_funds") {
        throw new ManagementError("Your budget pool does not have that much left", 409);
      }
      throw error;
    }
  });
}

// Maps service errors to HTTP responses; anything else goes to the
// generic error handler.
// Scheduling rules enforced by the database (migration 009).
const scheduleConflicts = {
  classes_key_uniq: "That class already exists for this teacher and block",
  classes_teacher_block_uniq: "That teacher already teaches a class in this block",
};

export function sendManagementError(error, res, next) {
  if (error?.code === "23505" && error.constraint?.startsWith("class_members_student_")) {
    return res.status(409).json({ message: error.message });
  }
  if (error?.code === "23505" && scheduleConflicts[error.constraint]) {
    return res.status(409).json({ message: scheduleConflicts[error.constraint] });
  }
  if (error instanceof ManagementError) {
    return res.status(error.status).json({ message: error.message, report: error.report });
  }
  if (error instanceof BudgetError) {
    const status = error.code === "insufficient_funds" ? 409 : 400;
    return res.status(status).json({ message: error.message });
  }
  return next(error);
}
