import { randomBytes } from "node:crypto";
import { getPool, withTransaction } from "../db/pool.js";
import {
  BudgetError,
  adjust,
  centsToDollars,
  dollarsToCents,
  ensureAccount,
  ensureSchoolAccount,
  grant,
  transfer,
} from "../budget/ledger.js";
import { createPasswordHash, verifyPassword } from "../utils/passwords.js";
import { clearFailures } from "../auth/loginThrottle.js";
import { log } from "../utils/log.js";
import { canRunJobs } from "../auth/jobPermission.js";

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

async function balanceCents(client, accountId) {
  const result = await client.query("SELECT balance_cents FROM budget_accounts WHERE id = $1", [accountId]);
  return Number(result.rows[0].balance_cents);
}

// Moves money in the transaction `client`, turning "not enough" into a 409
// that says how much the source has (`sourceLabel`: "The School account").
async function transferOr409(client, { fromAccountId, toAccountId, amountCents, note, createdBy }, sourceLabel, extra = "") {
  try {
    return await transfer(client, { fromAccountId, toAccountId, amountCents, note, createdBy });
  } catch (error) {
    if (error instanceof BudgetError && error.code === "insufficient_funds") {
      const left = formatCents(await balanceCents(client, fromAccountId));
      throw new ManagementError(`${sourceLabel} has only ${left} left${extra}`, 409);
    }
    throw error;
  }
}

// Funds an account from the School account (everything below School is
// funded this way; only School receives grants).
export async function fundFromSchool(client, { toAccountId, amountCents, note, createdBy }) {
  const schoolAccountId = await ensureSchoolAccount(client);
  return transferOr409(client, { fromAccountId: schoolAccountId, toAccountId, amountCents, note, createdBy }, "The School account");
}

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
    SELECT u.id, u.username, u.email, u.display_name, u.status, u.last_login_at, u.created_at, u.can_run_jobs,
           ARRAY(SELECT r.role::text FROM user_roles r WHERE r.user_id = u.id ORDER BY r.role) AS roles,
           ARRAY(SELECT i.provider FROM user_identities i WHERE i.user_id = u.id ORDER BY i.provider) AS sign_in,
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
    // The admin's setting (true, false, or null for the role default) and
    // the result.
    canRunJobsOverride: row.can_run_jobs,
    canRunJobs: canRunJobs({ roles: row.roles, canRunJobsOverride: row.can_run_jobs }),
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    // How the user signs in: "local" (Talon password) and/or "entra" (Microsoft).
    signIn: row.sign_in,
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
        [userId, username, await createPasswordHash(password)],
      );
      return userId;
    });
    return { id, username, password };
  } catch (error) {
    return uniqueViolation(error, "That username or email is already in use");
  }
}

// Refuses a change that would leave no active admin. Locks every active admin
// row (in id order, before the target row) so two concurrent demotions cannot
// each see the other admin still in place.
async function assertAnotherActiveAdmin(client, userId) {
  const admins = await client.query(
    `SELECT u.id FROM users u
     WHERE u.status = 'active'
       AND EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role::text = 'admin')
     ORDER BY u.id FOR UPDATE OF u`,
  );
  const ids = admins.rows.map((row) => String(row.id));
  if (ids.includes(String(userId)) && ids.length === 1) {
    throw new ManagementError("There must be at least one active admin", 409);
  }
}

export async function updateUser(userId, input, actor) {
  try {
    return await withTransaction(async (client) => {
      const losesAdmin =
        input.status === "disabled" ||
        (input.roles !== undefined && !cleanRoles(input.roles).includes("admin"));
      if (losesAdmin) {
        await assertAnotherActiveAdmin(client, userId);
      }
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

      if (input.canRunJobs !== undefined) {
        if (![true, false, null].includes(input.canRunJobs)) {
          throw new ManagementError("canRunJobs must be true, false or null (the role default)");
        }
        await client.query("UPDATE users SET can_run_jobs = $2, updated_at = now() WHERE id = $1", [
          userId,
          input.canRunJobs,
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

// Permanently deletes an account that was never used (created by mistake).
// Anything that would lose history or leave something behind refuses with a
// 409 pointing at "disable" instead. Money the account only received is
// handled so every balance still equals its ledger: a grant (roster import,
// admin grant) vanishes with the account's ledger rows, since the money was
// created for this account. Anything else, a teacher's transfer included, means
// the account cannot be deleted: other accounts' ledger history is never
// rewritten.
// Locking order: active admins, then the user row, then budget accounts by id.
export async function deleteUnusedUser(userId, actor) {
  const hint = "Disable the account instead.";
  const deleted = await withTransaction(async (client) => {
    if (userId === actor.id) {
      throw new ManagementError("You cannot delete your own account", 400);
    }
    await assertAnotherActiveAdmin(client, userId);
    const found = await client.query("SELECT id, username FROM users WHERE id = $1 FOR UPDATE", [userId]);
    if (found.rows.length === 0) {
      throw new ManagementError("User not found", 404);
    }
    const { username } = found.rows[0];

    const exists = async (sql) => (await client.query(sql, [userId])).rows.length > 0;
    if (await exists("SELECT 1 FROM jobs WHERE owner_user_id = $1 LIMIT 1")) {
      throw new ManagementError(`${username} has submitted jobs (hidden ones count), so the account cannot be deleted. ${hint}`, 409);
    }
    if (await exists("SELECT 1 FROM classes WHERE teacher_id = $1 LIMIT 1")) {
      throw new ManagementError(`${username} teaches a class. Reassign the class first, or ${hint.toLowerCase()}`, 409);
    }
    // GitHub and Google Drive links both live in `connections` (the older
    // github_accounts / github_credentials tables no longer exist).
    if (await exists("SELECT 1 FROM connections WHERE user_id = $1 LIMIT 1")) {
      throw new ManagementError(
        `${username} has a GitHub or Google Drive account connected. Disconnect it first (Unlink GitHub, or the connection's Disconnect) so the stored token is revoked, then delete.`,
        409,
      );
    }

    // Budget: lock this user's accounts, then look at every entry.
    const accounts = await client.query(
      "SELECT id FROM budget_accounts WHERE owner_user_id = $1 ORDER BY id FOR UPDATE",
      [userId],
    );
    const accountIds = accounts.rows.map((row) => Number(row.id));
    const entries = await client.query(
      `SELECT id, account_id, amount_cents, kind, transfer_id, job_id
       FROM budget_ledger WHERE account_id = ANY($1::bigint[]) ORDER BY id`,
      [accountIds],
    );
    const usedMessage = `${username} has budget activity other than a starting budget (a teacher's allocation, charges, refunds or adjustments). ${hint}`;
    // A starting budget is money in from the School account (or, before the
    // School account, a grant). Its School half is removed with the user's
    // half below, so the money goes back to School as if never given.
    const fromSchool = await client.query(
      `SELECT s.id, s.account_id, s.amount_cents, s.transfer_id
       FROM budget_ledger s JOIN budget_accounts a ON a.id = s.account_id AND a.kind = 'school'
       WHERE s.transfer_id = ANY($1::uuid[]) AND s.amount_cents < 0`,
      [entries.rows.filter((e) => e.kind === "transfer").map((e) => e.transfer_id)],
    );
    const schoolHalf = new Map(fromSchool.rows.map((row) => [row.transfer_id, row]));
    if (
      entries.rows.some(
        (e) =>
          e.job_id !== null ||
          Number(e.amount_cents) <= 0 ||
          !(e.kind === "grant" || (e.kind === "transfer" && -Number(schoolHalf.get(e.transfer_id)?.amount_cents) === Number(e.amount_cents))),
      )
    ) {
      throw new ManagementError(usedMessage, 409);
    }
    const madeEntries = await client.query(
      "SELECT 1 FROM budget_ledger WHERE created_by = $1 AND NOT (account_id = ANY($2::bigint[])) LIMIT 1",
      [userId, accountIds],
    );
    if (madeEntries.rows.length > 0) {
      throw new ManagementError(`${username} has made budget changes for other accounts, which would lose their record. ${hint}`, 409);
    }

    for (const half of fromSchool.rows) {
      await client.query("SELECT 1 FROM budget_accounts WHERE id = $1 FOR UPDATE", [half.account_id]);
      await client.query("DELETE FROM budget_ledger WHERE id = $1", [half.id]);
      await client.query("UPDATE budget_accounts SET balance_cents = balance_cents - $2 WHERE id = $1", [half.account_id, half.amount_cents]);
    }

    await revokeSessions(client, userId);
    // Cascades: roles, sign-in identities, class membership, budget accounts
    // and their ledger rows.
    await client.query("DELETE FROM users WHERE id = $1", [userId]);
    return { id: userId, username };
  });
  log.info(`admin ${actor.username} deleted unused user ${deleted.username}`, {
    event: "admin.user_deleted",
    userId: actor.id,
    deletedUserId: deleted.id,
    deletedUsername: deleted.username,
  });
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
      [userId, name, await createPasswordHash(password)],
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
// own session (keepSid) stays. Passwords are trimmed, as at login, so a
// padded password can still sign in.
export async function changeOwnPassword(userId, currentPassword, newPassword, keepSid) {
  currentPassword = String(currentPassword ?? "").trim();
  newPassword = String(newPassword ?? "").trim();
  if (newPassword.length < 8) {
    throw new ManagementError("New password must be at least 8 characters");
  }

  await withTransaction(async (client) => {
    const identity = await client.query(
      "SELECT password_hash FROM user_identities WHERE user_id = $1 AND provider = 'local' FOR UPDATE",
      [userId],
    );
    if (identity.rows.length === 0 || !(await verifyPassword(currentPassword, identity.rows[0].password_hash))) {
      throw new ManagementError("Current password is incorrect", 403);
    }
    await client.query(
      "UPDATE user_identities SET password_hash = $2 WHERE user_id = $1 AND provider = 'local'",
      [userId, await createPasswordHash(newPassword)],
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
      if (typeof input.archived !== "boolean") {
        throw new ManagementError("Archived must be true or false");
      }
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

// Admin puts several students into one class at once, each optionally with
// a starting budget (an admin grant to their personal budget, as roster
// import does). For students who signed in before anyone set them up (a new
// Microsoft account). All or nothing. A student already in the class is left
// as is and gets no second grant (a repeated click changes nothing).
// Returns { added, alreadyMembers, grantedCents } (grantedCents per student).
const maxAssignBatch = 200;

export async function assignStudentsToClass({ classId, userIds, budget }, actorId) {
  const ids = Array.isArray(userIds) ? [...new Set(userIds.map((id) => String(id ?? "").toLowerCase()))] : [];
  if (ids.length === 0) {
    throw new ManagementError("Choose at least one student");
  }
  if (ids.length > maxAssignBatch) {
    throw new ManagementError(`At most ${maxAssignBatch} students at a time`);
  }
  if (ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))) {
    throw new ManagementError("Choose students from the list");
  }
  const noBudget = budget === undefined || budget === null || String(budget).trim() === "" || Number(budget) === 0;
  const grantCents = noBudget ? 0 : toCents(budget);

  return withTransaction(async (client) => {
    const found = await client.query("SELECT name, block, archived_at FROM classes WHERE id = $1 FOR UPDATE", [classId]);
    if (found.rows.length === 0) {
      throw new ManagementError("Class not found", 404);
    }
    if (found.rows[0].archived_at) {
      throw new ManagementError("This class is archived", 409);
    }
    const { name, block } = found.rows[0];

    const users = await client.query(
      `SELECT u.id, u.username, u.status,
              EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = 'student') AS is_student
       FROM users u WHERE u.id = ANY($1::uuid[])
       ORDER BY u.id
       FOR UPDATE`,
      [ids],
    );
    if (users.rows.length !== ids.length) {
      throw new ManagementError("A chosen user no longer exists; reload the page", 404);
    }
    const notStudents = users.rows.filter((user) => !user.is_student).map((user) => user.username);
    if (notStudents.length) {
      throw new ManagementError(`Not students: ${notStudents.join(", ")}`);
    }
    const disabled = users.rows.filter((user) => user.status !== "active").map((user) => user.username);
    if (disabled.length) {
      throw new ManagementError(`Turned off (enable them first): ${disabled.join(", ")}`);
    }

    const inserted = await client.query(
      `INSERT INTO class_members (class_id, user_id)
       SELECT $1, id FROM unnest($2::uuid[]) AS id
       ON CONFLICT (class_id, user_id) DO NOTHING
       RETURNING user_id`,
      [classId, ids],
    );
    if (grantCents > 0) {
      const note = `Starting budget (${block ? `${name}, block ${block}` : name})`;
      for (const { user_id: userId } of inserted.rows) {
        const accountId = await ensureAccount(client, userId, "personal");
        await fundFromSchool(client, { toAccountId: accountId, amountCents: grantCents, note, createdBy: actorId });
      }
    }
    return {
      added: inserted.rows.length,
      alreadyMembers: ids.length - inserted.rows.length,
      grantedCents: grantCents,
    };
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

// Admin changes a balance. target "school": "increase" adds to the yearly
// budget (a grant, the only way money enters Talon), "decrease" removes
// some (never below $0). target "pool" (a teacher's pool) or "personal"
// (anyone's own budget, the admin's included): "increase" moves money from
// School to it, "decrease" moves it back to School (at most its balance).
export async function adjustBudget({ userId, target, direction, amount, note }, actorId) {
  if (!["school", "pool", "personal"].includes(target)) {
    throw new ManagementError("Target must be school, pool or personal");
  }
  if (!["increase", "decrease"].includes(direction)) {
    throw new ManagementError("Direction must be increase or decrease");
  }
  const amountCents = toCents(amount);

  await withTransaction(async (client) => {
    const schoolAccountId = await ensureSchoolAccount(client);

    if (target === "school") {
      const entry = {
        accountId: schoolAccountId,
        note: cleanText(note, 200) || (direction === "increase" ? "School budget" : "School budget correction"),
        createdBy: actorId,
      };
      if (direction === "increase") {
        await grant(client, { ...entry, amountCents });
        return;
      }
      try {
        await adjust(client, { ...entry, amountCents: -amountCents });
      } catch (error) {
        if (error instanceof BudgetError && error.code === "insufficient_funds") {
          throw new ManagementError(`The School account has only ${formatCents(await balanceCents(client, schoolAccountId))} left`, 409);
        }
        throw error;
      }
      return;
    }

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
    if (direction === "increase") {
      await transferOr409(
        client,
        { fromAccountId: schoolAccountId, toAccountId: accountId, amountCents, note: cleanText(note, 200) || "From the School account", createdBy: actorId },
        "The School account",
      );
    } else {
      await transferOr409(
        client,
        { fromAccountId: accountId, toAccountId: schoolAccountId, amountCents, note: cleanText(note, 200) || "Returned to the School account", createdBy: actorId },
        target === "pool" ? "The pool" : "That budget",
        target === "pool" ? "" : " (spent money and running jobs' reservations can't be taken back)",
      );
    }
  });
}

// The school year (July 1 to June 30) that contains `date`.
export function schoolYearContaining(date = new Date()) {
  const year = date.getUTCMonth() >= 6 ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
  return { from: `${year}-07-01`, to: `${year + 1}-06-30` };
}

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

// Money summary for the admin Overview: where the money is now, and what
// came into School and was spent between `from` and `to` (dates, inclusive,
// UTC; default the current school year). Spent is job compute (charges
// minus unused reservations returned), not the AWS bill; a running job's
// reservation counts as spent until it settles.
export async function budgetSummary({ from, to } = {}, { pool = getPool() } = {}) {
  const range = schoolYearContaining();
  const start = from || range.from;
  const end = to || range.to;
  if (!isoDate.test(start) || !isoDate.test(end) || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) {
    throw new ManagementError("Dates must look like 2026-07-01");
  }
  if (start > end) {
    throw new ManagementError("The start date must not be after the end date");
  }
  const result = await pool.query(
    `
      WITH period AS (
        SELECT l.kind, l.amount_cents, l.job_id, a.kind AS account_kind
        FROM budget_ledger l
        JOIN budget_accounts a ON a.id = l.account_id
        WHERE l.created_at >= $1::date AND l.created_at < $2::date + 1
      )
      SELECT
        COALESCE((SELECT balance_cents FROM budget_accounts WHERE kind = 'school'), 0) AS school_cents,
        COALESCE((SELECT SUM(balance_cents) FROM budget_accounts WHERE kind = 'teacher_pool'), 0) AS pools_cents,
        COALESCE((SELECT SUM(balance_cents) FROM budget_accounts WHERE kind = 'personal'), 0) AS personal_cents,
        COALESCE((SELECT SUM(reserved_cents) FROM jobs
                  WHERE reserved_cents > 0 AND result_sync_key IS NULL AND status IN ('queued', 'running')), 0) AS reserved_cents,
        COALESCE((SELECT SUM(amount_cents) FROM period WHERE account_kind = 'school' AND kind IN ('grant', 'adjustment')), 0) AS budget_cents,
        COALESCE((SELECT -SUM(amount_cents) FROM period WHERE kind IN ('charge', 'refund')), 0) AS spent_cents,
        (SELECT count(DISTINCT job_id) FROM period WHERE kind = 'charge') AS job_count
    `,
    [start, end],
  );
  const row = result.rows[0];
  const dollars = (key) => centsToDollars(Number(row[key]));
  return {
    from: start,
    to: end,
    // Now
    school: dollars("school_cents"),
    teacherPools: dollars("pools_cents"),
    personal: dollars("personal_cents"),
    reservedForRunningJobs: dollars("reserved_cents"),
    // In the period
    budget: dollars("budget_cents"),
    spent: dollars("spent_cents"),
    jobs: Number(row.job_count),
  };
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

// Teacher moves money between their own pool and their own personal budget
// (what their jobs spend): "to-me" (pool -> personal) or "to-pool".
export async function moveTeacherOwnBudget({ teacher, amount, direction = "to-me", note }) {
  if (!["to-me", "to-pool"].includes(direction)) {
    throw new ManagementError("Direction must be to-me or to-pool");
  }
  const amountCents = toCents(amount);

  await withTransaction(async (client) => {
    await assertUserHasRole(client, teacher.id, "teacher");
    const poolAccountId = await ensureAccount(client, teacher.id, "teacher_pool");
    const personalAccountId = await ensureAccount(client, teacher.id, "personal");
    if (direction === "to-me") {
      await transferOr409(
        client,
        { fromAccountId: poolAccountId, toAccountId: personalAccountId, amountCents, note: cleanText(note, 200) || "From my pool", createdBy: teacher.id },
        "Your pool",
      );
    } else {
      await transferOr409(
        client,
        { fromAccountId: personalAccountId, toAccountId: poolAccountId, amountCents, note: cleanText(note, 200) || "Back to my pool", createdBy: teacher.id },
        "Your own budget",
        " (spent money and running jobs' reservations can't be moved)",
      );
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
