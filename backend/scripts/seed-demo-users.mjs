import {
  createPasswordHash,
  initializeUsersDatabase,
} from "../src/utils/usersDatabase.js";
import { adminUser, teacherSeeds } from "../src/data/demoUsers.js";

function upsertUser(db, { username, fullName, password, userType }) {
  db.prepare(
    `
      INSERT INTO users (username, full_name, password_hash, user_type)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET
        full_name = excluded.full_name,
        password_hash = excluded.password_hash,
        user_type = excluded.user_type
    `,
  ).run(username, fullName, createPasswordHash(password), userType);
}

function upsertTeacherProfile(db, { username, className }) {
  db.prepare(
    `
      INSERT INTO teacher_profiles (username, class_name)
      VALUES (?, ?)
      ON CONFLICT(username) DO UPDATE SET
        class_name = excluded.class_name
    `,
  ).run(username, className);
}

function upsertStudentProfile(
  db,
  { username, teacherUsername, quota, tokensRemaining },
) {
  db.prepare(
    `
      INSERT INTO student_profiles (username, teacher_username, quota, tokens_remaining)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET
        teacher_username = excluded.teacher_username,
        quota = excluded.quota,
        tokens_remaining = excluded.tokens_remaining
    `,
  ).run(username, teacherUsername, quota, tokensRemaining);
}

function ensureClass(db, { className, teacherUsername }) {
  db.prepare(
    `
      INSERT INTO classes (class_name, teacher_username)
      VALUES (?, ?)
      ON CONFLICT(class_name, teacher_username) DO NOTHING
    `,
  ).run(className, teacherUsername);

  const row = db
    .prepare(
      `
      SELECT id
      FROM classes
      WHERE class_name = ? AND teacher_username = ?
    `,
    )
    .get(className, teacherUsername);

  return Number(row?.id ?? 0);
}

function replaceClassRoster(db, classId, studentUsernames) {
  db.prepare("DELETE FROM class_students WHERE class_id = ?").run(classId);

  const insertStudentLink = db.prepare(
    `
      INSERT INTO class_students (class_id, student_username)
      VALUES (?, ?)
    `,
  );

  for (const studentUsername of studentUsernames) {
    insertStudentLink.run(classId, studentUsername);
  }
}

function clearExistingDemoData(db) {
  db.exec(`
    DELETE FROM class_students;
    DELETE FROM classes;
    DELETE FROM student_profiles;
    DELETE FROM teacher_profiles;
    DELETE FROM users;
  `);
}

function summarize(db) {
  return {
    users: db.prepare("SELECT COUNT(*) AS count FROM users").get().count,
    teachers: db
      .prepare(
        "SELECT COUNT(*) AS count FROM users WHERE user_type = 'teacher'",
      )
      .get().count,
    students: db
      .prepare(
        "SELECT COUNT(*) AS count FROM users WHERE user_type = 'student'",
      )
      .get().count,
    admins: db
      .prepare("SELECT COUNT(*) AS count FROM users WHERE user_type = 'admin'")
      .get().count,
    classes: db.prepare("SELECT COUNT(*) AS count FROM classes").get().count,
    classStudents: db
      .prepare("SELECT COUNT(*) AS count FROM class_students")
      .get().count,
  };
}

async function main() {
  const db = await initializeUsersDatabase();

  db.exec("BEGIN TRANSACTION");

  try {
    clearExistingDemoData(db);
    upsertUser(db, adminUser);

    for (const teacherSeed of teacherSeeds) {
      upsertUser(db, {
        username: teacherSeed.username,
        fullName: teacherSeed.fullName,
        password: teacherSeed.password,
        userType: "teacher",
      });
      upsertTeacherProfile(db, {
        username: teacherSeed.username,
        className: teacherSeed.className,
      });

      for (const student of teacherSeed.students) {
        upsertUser(db, {
          username: student.username,
          fullName: student.fullName,
          password: student.password,
          userType: "student",
        });
        upsertStudentProfile(db, {
          username: student.username,
          teacherUsername: teacherSeed.username,
          quota: student.quota,
          tokensRemaining: student.tokensRemaining,
        });
      }

      const classId = ensureClass(db, {
        className: teacherSeed.className,
        teacherUsername: teacherSeed.username,
      });
      replaceClassRoster(
        db,
        classId,
        teacherSeed.students.map((student) => student.username),
      );
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const summary = summarize(db);
  console.log("Demo users seeded successfully.");
  console.log(JSON.stringify(summary, null, 2));
  console.log("Teacher password: teach123");
  console.log("Student password: student123");
  console.log("Admin password: admin123");
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
