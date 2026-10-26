import { getPool, withTransaction } from "../db/pool.js";
import { dollarsToCents, ensureAccount, grant } from "../budget/ledger.js";
import { createPasswordHash } from "../utils/passwords.js";
import {
  ManagementError,
  cleanEmail,
  cleanRoles,
  cleanText,
  cleanUsername,
  generatePassword,
  setRoles,
} from "./management.js";

// CSV roster import. Columns (header row required, any order, case-insensitive):
//   username, name, email, role, class, budget
// Only `username` is required. New users get a generated password; existing
// usernames are never changed (their class assignment is still applied).
// All-or-nothing: if any row is invalid nothing is written.

export const maxImportRows = 500;
const maxBudgetCents = 100_000_00;

const headerAliases = {
  username: ["username", "user", "login", "user name"],
  fullName: ["name", "full name", "full_name", "fullname", "display name", "display_name"],
  email: ["email", "e-mail", "email address"],
  roles: ["role", "roles"],
  className: ["class", "class name", "classes", "course"],
  budget: ["budget", "starting budget", "amount", "dollars"],
};

// RFC 4180-style parser: quoted fields, doubled quotes, CRLF or LF, BOM.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const input = String(text ?? "").replace(/^﻿/, "");

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (inQuotes) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[index + 1] === "\n") {
        index += 1;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

function mapColumns(headerCells) {
  const columns = {};
  headerCells.forEach((cell, index) => {
    const key = cell.trim().toLowerCase();
    for (const [field, aliases] of Object.entries(headerAliases)) {
      if (aliases.includes(key) && columns[field] === undefined) {
        columns[field] = index;
      }
    }
  });
  return columns;
}

function parseBudgetCents(value) {
  const text = String(value ?? "").replace(/[$,\s]/g, "");
  if (!text) {
    return 0;
  }
  const cents = dollarsToCents(text);
  if (!Number.isFinite(Number(text)) || !Number.isSafeInteger(cents) || cents < 0 || cents > maxBudgetCents) {
    throw new ManagementError("Budget must be a dollar amount from 0 to 100000");
  }
  return cents;
}

// Several roles in one cell: "teacher;student" or "teacher|student".
function parseRoles(value, defaultRole) {
  const parts = String(value ?? "")
    .toLowerCase()
    .split(/[;|/]/)
    .map((part) => part.trim())
    .filter(Boolean);
  return cleanRoles(parts.length > 0 ? parts : [defaultRole]);
}

function memberRoleFor(roles) {
  const memberRoles = roles.filter((role) => role === "student" || role === "teacher");
  if (memberRoles.length !== 1) {
    throw new ManagementError("A class needs a user who is either a student or a teacher, not both or neither");
  }
  return memberRoles[0];
}

// Validates every row against the file and the database; returns the plan.
async function planImport(csv, defaultRole, pool) {
  const cells = parseCsv(csv);
  if (cells.length === 0) {
    throw new ManagementError("The file is empty");
  }
  const columns = mapColumns(cells[0]);
  if (columns.username === undefined) {
    throw new ManagementError('The first row must be a header with at least a "username" column');
  }
  const dataRows = cells.slice(1);
  if (dataRows.length === 0) {
    throw new ManagementError("The file has a header but no users");
  }
  if (dataRows.length > maxImportRows) {
    throw new ManagementError(`At most ${maxImportRows} users per import; this file has ${dataRows.length}`);
  }

  const [existingUsers, existingClasses] = await Promise.all([
    pool.query(`SELECT u.id, lower(u.username) AS username, lower(u.email) AS email,
                       ARRAY(SELECT r.role::text FROM user_roles r WHERE r.user_id = u.id) AS roles
                FROM users u`),
    pool.query("SELECT id, name FROM classes WHERE archived_at IS NULL"),
  ]);
  const usersByName = new Map(existingUsers.rows.map((row) => [row.username, row]));
  const emailOwners = new Map(existingUsers.rows.filter((row) => row.email).map((row) => [row.email, row.username]));
  const classIdsByName = new Map(existingClasses.rows.map((row) => [row.name.trim().toLowerCase(), Number(row.id)]));

  const seenUsernames = new Map();
  const seenEmails = new Map();
  const newClassNames = new Map(); // lower name -> display name

  const rows = dataRows.map((cellsInRow, offset) => {
    const line = offset + 2; // header is line 1
    const get = (field) => (columns[field] === undefined ? "" : String(cellsInRow[columns[field]] ?? "").trim());
    const row = {
      line,
      username: get("username"),
      fullName: "",
      email: null,
      roles: [],
      className: "",
      budgetCents: 0,
      memberRole: null,
      action: "create",
      errors: [],
    };

    const attempt = (fn) => {
      try {
        fn();
      } catch (error) {
        if (!(error instanceof ManagementError)) throw error;
        row.errors.push(error.message);
      }
    };

    attempt(() => {
      row.username = cleanUsername(row.username);
    });
    row.fullName = cleanText(get("fullName"), 200) || row.username;
    attempt(() => {
      row.email = cleanEmail(get("email"));
    });
    attempt(() => {
      row.roles = parseRoles(get("roles"), defaultRole);
    });
    attempt(() => {
      row.budgetCents = parseBudgetCents(get("budget"));
    });
    row.className = cleanText(get("className"), 200);

    const key = row.username.toLowerCase();
    if (seenUsernames.has(key)) {
      row.errors.push(`Same username as line ${seenUsernames.get(key)}`);
    } else if (row.username) {
      seenUsernames.set(key, line);
    }
    if (row.email) {
      const emailKey = row.email.toLowerCase();
      if (seenEmails.has(emailKey)) {
        row.errors.push(`Same email as line ${seenEmails.get(emailKey)}`);
      } else {
        seenEmails.set(emailKey, line);
      }
    }

    const existing = usersByName.get(key);
    if (existing) {
      row.action = "exists";
      row.existingId = existing.id;
      // No role in the file: keep what they already are (so a class can still be applied).
      if (!get("roles")) {
        row.roles = existing.roles;
      }
    } else if (row.email && emailOwners.has(row.email.toLowerCase())) {
      row.errors.push(`Email already belongs to ${emailOwners.get(row.email.toLowerCase())}`);
    }

    if (row.className) {
      attempt(() => {
        row.memberRole = memberRoleFor(row.roles);
        if (row.action === "exists" && !existing.roles.includes(row.memberRole)) {
          throw new ManagementError(`${row.username} already exists and is not a ${row.memberRole}`);
        }
      });
      const classKey = row.className.toLowerCase();
      if (!classIdsByName.has(classKey) && !newClassNames.has(classKey)) {
        newClassNames.set(classKey, row.className);
      }
    }

    if (row.budgetCents > 0) {
      if (row.action === "exists") {
        row.errors.push("Budget is only applied to new users; change existing budgets from the lists");
      } else if (!row.roles.includes("student") && !row.roles.includes("teacher")) {
        row.errors.push("Only students and teachers have a budget");
      }
    }

    return row;
  });

  return { rows, classIdsByName, newClassNames };
}

function toReport(plan) {
  const rows = plan.rows.map((row) => ({
    line: row.line,
    username: row.username,
    fullName: row.fullName,
    email: row.email,
    roles: row.roles,
    className: row.className,
    budget: row.budgetCents / 100,
    action: row.errors.length > 0 ? "error" : row.action,
    errors: row.errors,
  }));
  return {
    summary: {
      total: rows.length,
      create: rows.filter((row) => row.action === "create").length,
      exists: rows.filter((row) => row.action === "exists").length,
      errors: rows.filter((row) => row.action === "error").length,
      newClasses: [...plan.newClassNames.values()],
    },
    rows,
  };
}

// dryRun: validate and describe only. Otherwise writes everything in one
// transaction and returns the generated passwords (the only time they exist).
export async function importRoster({ csv, defaultRole = "student", dryRun = true }, actorId) {
  const plan = await planImport(csv, defaultRole, getPool());
  const report = toReport(plan);

  if (dryRun) {
    return { ...report, dryRun: true };
  }
  if (report.summary.errors > 0) {
    const error = new ManagementError(`Fix the ${report.summary.errors} row(s) with errors before importing`, 422);
    error.report = report;
    throw error;
  }

  const credentials = [];
  await withTransaction(async (client) => {
    const classIds = new Map(plan.classIdsByName);
    for (const [key, name] of plan.newClassNames) {
      const inserted = await client.query("INSERT INTO classes (name) VALUES ($1) RETURNING id", [name]);
      classIds.set(key, Number(inserted.rows[0].id));
    }

    for (const row of plan.rows) {
      let userId = row.existingId;

      if (row.action === "create") {
        const password = generatePassword();
        const inserted = await client.query(
          "INSERT INTO users (username, email, display_name) VALUES ($1, $2, $3) RETURNING id",
          [row.username, row.email, row.fullName],
        );
        userId = inserted.rows[0].id;
        await setRoles(client, userId, row.roles, actorId);
        await client.query(
          `INSERT INTO user_identities (user_id, provider, subject, password_hash)
           VALUES ($1, 'local', lower($2), $3)`,
          [userId, row.username, createPasswordHash(password)],
        );
        credentials.push({ username: row.username, fullName: row.fullName, password });

        if (row.budgetCents > 0) {
          const accountId = await ensureAccount(
            client,
            userId,
            row.roles.includes("teacher") ? "teacher_pool" : "personal",
          );
          await grant(client, { accountId, amountCents: row.budgetCents, note: "Roster import", createdBy: actorId });
        }
        // Hashing is CPU-heavy; let other requests through between users.
        await new Promise((resolve) => setImmediate(resolve));
      }

      if (row.className) {
        await client.query(
          `INSERT INTO class_members (class_id, user_id, member_role) VALUES ($1, $2, $3)
           ON CONFLICT (class_id, user_id) DO UPDATE SET member_role = EXCLUDED.member_role`,
          [classIds.get(row.className.toLowerCase()), userId, row.memberRole],
        );
      }
    }
  });

  return { ...report, dryRun: false, credentials };
}
