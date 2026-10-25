import { withTransaction } from "./pool.js";
import { createPasswordHash } from "../utils/passwords.js";
import { ensureAccount, grant, transfer, charge } from "../budget/ledger.js";
import { adminUser, teacherSeeds } from "../data/demoUsers.js";

// Original README demo login, kept so documented credentials keep working.
const legacyTeacher = {
  username: "talon_user",
  fullName: "Taylor Loudoun",
  password: "youwillneverguesswhereiwasyesterday",
  className: "ML Foundations",
  students: [
    {
      username: "jane_smith",
      fullName: "Jane Smith",
      password: "talon123",
      quota: 1200,
      tokensRemaining: 840,
    },
  ],
};

const teacherPoolCents = 100_00; // $100 per teacher pool

function allDemoUsernames(teachers) {
  return [
    adminUser.username,
    ...teachers.flatMap((teacher) => [
      teacher.username,
      ...teacher.students.map((student) => student.username),
    ]),
  ].map((username) => username.toLowerCase());
}

async function insertUser(client, { username, fullName, password, roles }) {
  const result = await client.query(
    "INSERT INTO users (username, display_name) VALUES ($1, $2) RETURNING id",
    [username, fullName],
  );
  const userId = result.rows[0].id;

  for (const role of roles) {
    await client.query("INSERT INTO user_roles (user_id, role) VALUES ($1, $2)", [
      userId,
      role,
    ]);
  }

  await client.query(
    `
      INSERT INTO user_identities (user_id, provider, subject, password_hash)
      VALUES ($1, 'local', $2, $3)
    `,
    [userId, username.toLowerCase(), createPasswordHash(password)],
  );

  return userId;
}

// Replaces all demo data. Refuses to run if the database has any users that
// are not demo users, so it can't wipe real accounts.
export function demoUsernames() {
  return allDemoUsernames([...teacherSeeds, legacyTeacher]);
}

// Demo passwords are public (they're in this repo), so demo users must never
// exist on a reachable server. Production requires an explicit opt-in.
function assertDemoSeedAllowed() {
  if (
    process.env.NODE_ENV === "production" &&
    process.env.TALON_ALLOW_DEMO_SEED !== "true"
  ) {
    throw new Error(
      "Refusing to seed demo users with NODE_ENV=production (their passwords are public). " +
        "Set TALON_ALLOW_DEMO_SEED=true only on a private demo server.",
    );
  }
}

export async function seedDemoUsers(pool) {
  assertDemoSeedAllowed();
  const teachers = [...teacherSeeds, legacyTeacher];
  const demoUsernames = allDemoUsernames(teachers);

  return withTransaction(
    async (client) => {
      const nonDemo = await client.query(
        "SELECT username FROM users WHERE NOT (lower(username) = ANY($1::text[])) LIMIT 5",
        [demoUsernames],
      );
      if (nonDemo.rows.length > 0) {
        throw new Error(
          `Refusing to seed: database has non-demo users (${nonDemo.rows
            .map((row) => row.username)
            .join(", ")})`,
        );
      }

      await client.query("TRUNCATE users, classes, sessions CASCADE");

      const adminId = await insertUser(client, { ...adminUser, roles: ["admin"] });
      await ensureAccount(client, adminId, "personal");

      for (const teacherSeed of teachers) {
        const teacherId = await insertUser(client, {
          ...teacherSeed,
          roles: ["teacher"],
        });
        await ensureAccount(client, teacherId, "personal");
        const poolAccountId = await ensureAccount(client, teacherId, "teacher_pool");
        await grant(client, {
          accountId: poolAccountId,
          amountCents: teacherPoolCents,
          note: "Demo pool funding",
          createdBy: adminId,
        });

        const classResult = await client.query(
          "INSERT INTO classes (name, term) VALUES ($1, '2026-27') RETURNING id",
          [teacherSeed.className],
        );
        const classId = classResult.rows[0].id;
        await client.query(
          "INSERT INTO class_members (class_id, user_id, member_role) VALUES ($1, $2, 'teacher')",
          [classId, teacherId],
        );

        for (const studentSeed of teacherSeed.students) {
          const studentId = await insertUser(client, {
            ...studentSeed,
            roles: ["student"],
          });
          await client.query(
            "INSERT INTO class_members (class_id, user_id, member_role) VALUES ($1, $2, 'student')",
            [classId, studentId],
          );

          // Legacy demo tokens map 1:1 to cents ($12.00 granted, $8.40 left).
          const personalAccountId = await ensureAccount(client, studentId, "personal");
          await transfer(client, {
            fromAccountId: poolAccountId,
            toAccountId: personalAccountId,
            amountCents: studentSeed.quota,
            note: "Demo class allocation",
            createdBy: teacherId,
          });

          const spentCents = studentSeed.quota - studentSeed.tokensRemaining;
          if (spentCents > 0) {
            await charge(client, {
              accountId: personalAccountId,
              amountCents: spentCents,
              jobId: null,
              note: "Demo historical usage",
            });
          }
        }
      }

      const counts = await client.query(`
        SELECT
          (SELECT COUNT(*) FROM users)::int AS users,
          (SELECT COUNT(*) FROM user_roles WHERE role = 'admin')::int AS admins,
          (SELECT COUNT(*) FROM user_roles WHERE role = 'teacher')::int AS teachers,
          (SELECT COUNT(*) FROM user_roles WHERE role = 'student')::int AS students,
          (SELECT COUNT(*) FROM classes)::int AS classes
      `);
      return counts.rows[0];
    },
    { pool },
  );
}
