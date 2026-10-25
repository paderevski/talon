import { randomBytes } from "node:crypto";
import { getPool, withTransaction } from "../db/pool.js";
import {
  BudgetError,
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

function cleanText(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function cleanRoles(roles) {
  const list = [...new Set((Array.isArray(roles) ? roles : []).map((role) => String(role)))];
  if (list.length === 0 || list.some((role) => !allRoles.includes(role))) {
    throw new ManagementError("Choose at least one role: student, teacher or admin");
  }
  return list;
}

function cleanUsername(value) {
  const username = cleanText(value, 100);
  if (!/^[A-Za-z0-9._@+-]{3,100}$/.test(username)) {
    throw new ManagementError(
      "Username must be 3-100 characters: letters, numbers and . _ @ + -",
    );
  }
  return username;
}

function cleanEmail(value) {
  const email = cleanText(value, 200);
  if (!email) {
    return null;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ManagementError("Email address is not valid");
  }
  return email;
}

function toCents(dollars) {
  const cents = dollarsToCents(dollars);
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > maxGrantCents) {
    throw new ManagementError("Amount must be more than $0 and at most $100,000");
  }
  return cents;
}

function uniqueViolation(error, message) {
  if (error?.code === "23505") {
    throw new ManagementError(message, 409);
  }
  throw error;
}

async function setRoles(client, userId, roles, grantedBy) {
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

async function revokeSessions(client, userId) {
  await client.query("DELETE FROM sessions WHERE sess->>'userId' = $1", [userId]);
}

// ---- Users -------------------------------------------------------------

export async function listUsers({ pool = getPool() } = {}) {
  const result = await pool.query(`
    SELECT u.id, u.username, u.email, u.display_name, u.status, u.last_login_at,
           ARRAY(SELECT r.role::text FROM user_roles r WHERE r.user_id = u.id ORDER BY r.role) AS roles,
           personal.balance_cents AS personal_cents,
           pool.balance_cents AS pool_cents,
           COALESCE((
             SELECT json_agg(json_build_object('id', c.id, 'name', c.name, 'memberRole', m.member_role)
                             ORDER BY c.name)
             FROM class_members m JOIN classes c ON c.id = m.class_id AND c.archived_at IS NULL
             WHERE m.user_id = u.id
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
            `SELECT 1 FROM class_members m JOIN classes c ON c.id = m.class_id AND c.archived_at IS NULL
             WHERE m.user_id = $1 AND m.member_role = $2 LIMIT 1`,
            [userId, role],
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
export async function resetPassword(userId) {
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
    await revokeSessions(client, userId);
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

export async function listClasses({ includeArchived = false, pool = getPool() } = {}) {
  const [classes, members] = await Promise.all([
    pool.query(
      `SELECT id, name, term, archived_at FROM classes
       ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY lower(name), id`,
    ),
    pool.query(`
      SELECT m.class_id, m.member_role, u.id AS user_id, u.username, u.display_name,
             a.balance_cents
      FROM class_members m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN budget_accounts a ON a.owner_user_id = u.id AND a.kind = 'personal'
      ORDER BY lower(u.display_name), lower(u.username)
    `),
  ]);

  return classes.rows.map((row) => {
    const classMembers = members.rows.filter((member) => Number(member.class_id) === Number(row.id));
    const shape = (member) => ({
      id: member.user_id,
      username: member.username,
      fullName: member.display_name,
      balance: centsToDollars(member.balance_cents ?? 0),
    });
    return {
      id: Number(row.id),
      name: row.name,
      term: row.term,
      archived: row.archived_at !== null,
      teachers: classMembers.filter((member) => member.member_role === "teacher").map(shape),
      students: classMembers.filter((member) => member.member_role === "student").map(shape),
    };
  });
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

export async function createClass(input) {
  const name = cleanText(input?.name, 200);
  if (!name) {
    throw new ManagementError("Class name is required");
  }
  const term = cleanText(input?.term, 50) || null;

  return withTransaction(async (client) => {
    const inserted = await client.query(
      "INSERT INTO classes (name, term) VALUES ($1, $2) RETURNING id",
      [name, term],
    );
    const classId = Number(inserted.rows[0].id);
    if (input?.teacherId) {
      await assertUserHasRole(client, input.teacherId, "teacher");
      await client.query(
        "INSERT INTO class_members (class_id, user_id, member_role) VALUES ($1, $2, 'teacher')",
        [classId, input.teacherId],
      );
    }
    return classId;
  });
}

export async function updateClass(classId, input) {
  const found = await getPool().query("SELECT id FROM classes WHERE id = $1", [classId]);
  if (found.rows.length === 0) {
    throw new ManagementError("Class not found", 404);
  }

  if (input.name !== undefined) {
    const name = cleanText(input.name, 200);
    if (!name) {
      throw new ManagementError("Class name is required");
    }
    await getPool().query("UPDATE classes SET name = $2 WHERE id = $1", [classId, name]);
  }
  if (input.term !== undefined) {
    await getPool().query("UPDATE classes SET term = $2 WHERE id = $1", [
      classId,
      cleanText(input.term, 50) || null,
    ]);
  }
  if (input.archived !== undefined) {
    await getPool().query(
      `UPDATE classes SET archived_at = ${input.archived ? "COALESCE(archived_at, now())" : "NULL"}
       WHERE id = $1`,
      [classId],
    );
  }
}

export async function addClassMember(classId, userId, memberRole) {
  if (!["teacher", "student"].includes(memberRole)) {
    throw new ManagementError("Member role must be teacher or student");
  }

  await withTransaction(async (client) => {
    const found = await client.query("SELECT archived_at FROM classes WHERE id = $1", [classId]);
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
    await client.query(
      `INSERT INTO class_members (class_id, user_id, member_role) VALUES ($1, $2, $3)
       ON CONFLICT (class_id, user_id) DO UPDATE SET member_role = EXCLUDED.member_role`,
      [classId, userId, memberRole],
    );
  });
}

export async function removeClassMember(classId, userId) {
  await getPool().query("DELETE FROM class_members WHERE class_id = $1 AND user_id = $2", [
    classId,
    userId,
  ]);
}

// ---- Budgets -----------------------------------------------------------

// Admin adds money: to a teacher's pool, or straight to anyone's personal budget.
export async function grantBudget({ userId, target, amount, note }, actorId) {
  if (!["pool", "personal"].includes(target)) {
    throw new ManagementError("Target must be pool or personal");
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
    await grant(client, {
      accountId,
      amountCents,
      note: cleanText(note, 200) || "Admin grant",
      createdBy: actorId,
    });
  });
}

// Teacher moves money from their pool to a student in one of their classes.
export async function allocateToStudent({ teacher, studentUsername, amount, note }) {
  const amountCents = toCents(amount);

  await withTransaction(async (client) => {
    const student = await client.query(
      `SELECT s.id FROM users s
       JOIN class_members sm ON sm.user_id = s.id AND sm.member_role = 'student'
       JOIN class_members tm ON tm.class_id = sm.class_id AND tm.member_role = 'teacher' AND tm.user_id = $2
       JOIN classes c ON c.id = sm.class_id AND c.archived_at IS NULL
       WHERE lower(s.username) = lower($1) AND s.status = 'active'
       LIMIT 1`,
      [cleanText(studentUsername, 100), teacher.id],
    );
    if (student.rows.length === 0) {
      throw new ManagementError("That student is not in one of your classes", 404);
    }

    const poolAccountId = await ensureAccount(client, teacher.id, "teacher_pool");
    const studentAccountId = await ensureAccount(client, student.rows[0].id, "personal");
    await transfer(client, {
      fromAccountId: poolAccountId,
      toAccountId: studentAccountId,
      amountCents,
      note: cleanText(note, 200) || "Teacher allocation",
      createdBy: teacher.id,
    });
  });
}

// Maps service errors to HTTP responses; anything else goes to the
// generic error handler.
export function sendManagementError(error, res, next) {
  if (error instanceof ManagementError) {
    return res.status(error.status).json({ message: error.message });
  }
  if (error instanceof BudgetError) {
    const status = error.code === "insufficient_funds" ? 409 : 400;
    return res.status(status).json({ message: error.message });
  }
  return next(error);
}
