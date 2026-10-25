import { mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import {
  createPasswordHash as hashPassword,
  verifyPassword,
} from "./passwords.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const validUserTypes = new Set(["student", "teacher", "admin"]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultDatabasePath = path.resolve(
  __dirname,
  "../../data/talon-demo.sqlite",
);

let database = null;
let initializePromise = null;

function normalizeUserType(userType) {
  const normalizedUserType = String(userType ?? "")
    .trim()
    .toLowerCase();
  return validUserTypes.has(normalizedUserType)
    ? normalizedUserType
    : "student";
}

function getDatabasePath() {
  const configuredPath = String(process.env.TALON_DB_PATH ?? "").trim();
  return configuredPath || defaultDatabasePath;
}

export function createPasswordHash(password) {
  return hashPassword(password);
}

function mapUserRow(row) {
  if (!row) {
    return null;
  }

  const role = normalizeUserType(row.user_type);
  const username = String(row.username ?? "").trim();
  return {
    id: username, // SQLite has no surrogate id; username stands in until SQLite is removed
    username,
    fullName: String(row.full_name ?? "").trim(),
    status: "active",
    role,
    roles: [role],
  };
}

function createSchema(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      user_type TEXT NOT NULL CHECK (user_type IN ('student', 'teacher', 'admin'))
    );

    CREATE TABLE IF NOT EXISTS teacher_profiles (
      username TEXT PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE,
      class_name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS student_profiles (
      username TEXT PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE,
      teacher_username TEXT REFERENCES users(username) ON DELETE SET NULL,
      quota INTEGER NOT NULL DEFAULT 0 CHECK (quota >= 0),
      tokens_remaining INTEGER NOT NULL DEFAULT 0 CHECK (tokens_remaining >= 0)
    );

    CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_name TEXT NOT NULL,
      teacher_username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      UNIQUE (class_name, teacher_username)
    );

    CREATE TABLE IF NOT EXISTS class_students (
      class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      student_username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      PRIMARY KEY (class_id, student_username)
    );

    PRAGMA user_version = 1;
  `);
}

function seedDemoData(db) {
  const existingUserCount = db
    .prepare("SELECT COUNT(*) AS count FROM users")
    .get()?.count;

  if (Number(existingUserCount) > 0) {
    return;
  }

  const insertUser = db.prepare(`
    INSERT INTO users (username, full_name, password_hash, user_type)
    VALUES (?, ?, ?, ?)
  `);
  const insertTeacherProfile = db.prepare(`
    INSERT INTO teacher_profiles (username, class_name)
    VALUES (?, ?)
  `);
  const insertStudentProfile = db.prepare(`
    INSERT INTO student_profiles (username, teacher_username, quota, tokens_remaining)
    VALUES (?, ?, ?, ?)
  `);
  const insertClass = db.prepare(`
    INSERT INTO classes (class_name, teacher_username)
    VALUES (?, ?)
  `);
  const insertClassStudent = db.prepare(`
    INSERT INTO class_students (class_id, student_username)
    VALUES (?, ?)
  `);

  db.exec("BEGIN TRANSACTION");

  try {
    insertUser.run(
      "jane_smith",
      "Jane Smith",
      hashPassword("talon123"),
      "student",
    );
    insertUser.run(
      "talon_user",
      "Taylor Loudoun",
      hashPassword("youwillneverguesswhereiwasyesterday"),
      "teacher",
    );
    insertUser.run(
      "admin",
      "Talon Administrator",
      hashPassword("admin123"),
      "admin",
    );

    insertTeacherProfile.run("talon_user", "ML Foundations");
    insertStudentProfile.run("jane_smith", "talon_user", 1200, 840);

    const classResult = insertClass.run("ML Foundations", "talon_user");
    insertClassStudent.run(Number(classResult.lastInsertRowid), "jane_smith");

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function openDatabase() {
  const databasePath = getDatabasePath();
  await mkdir(path.dirname(databasePath), { recursive: true });

  const db = new DatabaseSync(databasePath);
  createSchema(db);
  seedDemoData(db);
  return db;
}

export async function initializeUsersDatabase() {
  if (!initializePromise) {
    initializePromise = openDatabase().then((db) => {
      database = db;
      return db;
    });
  }

  return initializePromise;
}

function getDatabase() {
  if (!database) {
    throw new Error("Users database has not been initialized");
  }

  return database;
}

export async function findUserByCredentials(username, password) {
  await initializeUsersDatabase();

  const row = getDatabase()
    .prepare(
      `
      SELECT username, full_name, password_hash, user_type
      FROM users
      WHERE username = ?
    `,
    )
    .get(String(username ?? "").trim());

  if (!row || !verifyPassword(password, row.password_hash)) {
    return null;
  }

  return mapUserRow(row);
}

export async function findUserByUsername(username) {
  await initializeUsersDatabase();

  const row = getDatabase()
    .prepare(
      `
      SELECT username, full_name, user_type
      FROM users
      WHERE username = ?
    `,
    )
    .get(String(username ?? "").trim());

  return mapUserRow(row);
}

export async function listAdminRoster() {
  await initializeUsersDatabase();

  const db = getDatabase();
  const users = db
    .prepare(
      `
        SELECT username, full_name, user_type
        FROM users
        ORDER BY user_type, full_name, username
      `,
    )
    .all();
  const classes = db
    .prepare(
      `
        SELECT c.id, c.class_name, c.teacher_username, u.full_name AS teacher_full_name
        FROM classes c
        JOIN users u ON u.username = c.teacher_username
        ORDER BY c.class_name, c.teacher_username
      `,
    )
    .all();
  const students = db
    .prepare(
      `
        SELECT sp.username, sp.teacher_username, sp.quota, sp.tokens_remaining,
               u.full_name AS student_full_name,
               teacher.full_name AS teacher_full_name,
               cs.class_id
        FROM student_profiles sp
        JOIN users u ON u.username = sp.username
        LEFT JOIN users teacher ON teacher.username = sp.teacher_username
        LEFT JOIN class_students cs ON cs.student_username = sp.username
        ORDER BY teacher_full_name, student_full_name, sp.username
      `,
    )
    .all();
  const teacherProfiles = db
    .prepare(
      `
        SELECT tp.username, tp.class_name, u.full_name
        FROM teacher_profiles tp
        JOIN users u ON u.username = tp.username
        ORDER BY u.full_name, tp.username
      `,
    )
    .all();

  const classById = new Map(
    classes.map((item) => [
      Number(item.id),
      {
        id: Number(item.id),
        className: String(item.class_name ?? "").trim(),
        teacherUsername: String(item.teacher_username ?? "").trim(),
        teacherFullName: String(item.teacher_full_name ?? "").trim(),
        students: [],
      },
    ]),
  );

  const teacherByUsername = new Map(
    teacherProfiles.map((item) => [
      String(item.username ?? "").trim(),
      {
        username: String(item.username ?? "").trim(),
        fullName: String(item.full_name ?? "").trim(),
        className: String(item.class_name ?? "").trim(),
        students: [],
      },
    ]),
  );

  const studentItems = students.map((item) => ({
    username: String(item.username ?? "").trim(),
    fullName: String(item.student_full_name ?? "").trim(),
    teacherUsername: String(item.teacher_username ?? "").trim(),
    teacherFullName: String(item.teacher_full_name ?? "").trim(),
    quota: Number(item.quota ?? 0),
    tokensRemaining: Number(item.tokens_remaining ?? 0),
    classId: Number(item.class_id ?? 0),
  }));

  for (const student of studentItems) {
    const teacher = teacherByUsername.get(student.teacherUsername);
    if (teacher) {
      teacher.students.push(student);
    }

    const classItem = classById.get(student.classId);
    if (classItem) {
      classItem.students.push(student);
    }
  }

  return {
    stats: {
      userCount: users.length,
      teacherCount: users.filter((item) => item.user_type === "teacher").length,
      studentCount: users.filter((item) => item.user_type === "student").length,
      adminCount: users.filter((item) => item.user_type === "admin").length,
      classCount: classById.size,
    },
    admins: users
      .filter((item) => item.user_type === "admin")
      .map((item) => ({
        username: String(item.username ?? "").trim(),
        fullName: String(item.full_name ?? "").trim(),
      })),
    teachers: Array.from(teacherByUsername.values()),
    classes: Array.from(classById.values()),
  };
}

export async function getTeacherRoster(username) {
  await initializeUsersDatabase();

  const normalizedUsername = String(username ?? "").trim();
  const teacher = await findUserByUsername(normalizedUsername);
  if (!teacher || teacher.role !== "teacher") {
    return null;
  }

  const db = getDatabase();
  const teacherProfile = db
    .prepare(
      `
        SELECT class_name
        FROM teacher_profiles
        WHERE username = ?
      `,
    )
    .get(normalizedUsername);
  const students = db
    .prepare(
      `
        SELECT sp.username, sp.quota, sp.tokens_remaining, u.full_name
        FROM student_profiles sp
        JOIN users u ON u.username = sp.username
        WHERE sp.teacher_username = ?
        ORDER BY u.full_name, sp.username
      `,
    )
    .all(normalizedUsername)
    .map((item) => ({
      username: String(item.username ?? "").trim(),
      fullName: String(item.full_name ?? "").trim(),
      quota: Number(item.quota ?? 0),
      tokensRemaining: Number(item.tokens_remaining ?? 0),
    }));

  return {
    teacher: {
      username: teacher.username,
      fullName: teacher.fullName,
      className: String(teacherProfile?.class_name ?? "").trim(),
    },
    students,
  };
}

export async function listStudentUsernamesForTeacher(teacherUsername) {
  await initializeUsersDatabase();

  return getDatabase()
    .prepare(
      `
        SELECT DISTINCT cs.student_username AS username
        FROM classes c
        JOIN class_students cs ON cs.class_id = c.id
        WHERE c.teacher_username = ?
      `,
    )
    .all(String(teacherUsername ?? "").trim())
    .map((row) => String(row.username ?? "").trim());
}
