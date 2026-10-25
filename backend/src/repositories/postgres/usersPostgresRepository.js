import { getPool } from "../../db/pool.js";
import { centsToDollars } from "../../budget/ledger.js";
import { burnPasswordCheck, verifyPassword } from "../../utils/passwords.js";

// Highest role wins for the single `role` field older callers still read.
const rolePrecedence = ["admin", "teacher", "student"];

function primaryRole(roles) {
  return rolePrecedence.find((role) => roles.includes(role)) || "student";
}

const userSelect = `
  SELECT u.id, u.username, u.display_name, u.email, u.status,
         u.storage_quota_bytes, u.storage_used_bytes,
         ARRAY(SELECT r.role::text FROM user_roles r WHERE r.user_id = u.id ORDER BY r.role) AS roles
  FROM users u
`;

function mapUserRow(row) {
  if (!row) {
    return null;
  }

  const roles = row.roles ?? [];
  return {
    id: row.id,
    username: row.username,
    fullName: row.display_name,
    email: row.email,
    status: row.status,
    role: primaryRole(roles),
    roles,
    storageQuotaBytes: Number(row.storage_quota_bytes),
    storageUsedBytes: Number(row.storage_used_bytes),
  };
}

// Legacy roster fields: `quota` = total ever credited to the personal
// account, `tokensRemaining` = current balance. Both in dollars.
function mapStudentBudget(row) {
  return {
    quota: centsToDollars(row.credited_cents ?? 0),
    tokensRemaining: centsToDollars(row.balance_cents ?? 0),
  };
}

const personalBudgetJoin = `
  LEFT JOIN budget_accounts a ON a.owner_user_id = s.id AND a.kind = 'personal'
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(l.amount_cents) FILTER (WHERE l.amount_cents > 0), 0) AS credited_cents
    FROM budget_ledger l WHERE l.account_id = a.id
  ) credited ON true
`;

export function createUsersPostgresRepository({ pool = getPool() } = {}) {
  async function findByUsername(username) {
    const result = await pool.query(
      `${userSelect} WHERE lower(u.username) = lower($1)`,
      [String(username ?? "").trim()],
    );
    return mapUserRow(result.rows[0]);
  }

  async function findById(id) {
    const result = await pool.query(`${userSelect} WHERE u.id = $1`, [id]);
    return mapUserRow(result.rows[0]);
  }

  async function findByCredentials(username, password) {
    const normalizedUsername = String(username ?? "").trim().toLowerCase();
    const result = await pool.query(
      `
        SELECT i.user_id, i.password_hash, u.status
        FROM user_identities i
        JOIN users u ON u.id = i.user_id
        WHERE i.provider = 'local' AND i.subject = $1
      `,
      [normalizedUsername],
    );
    const identity = result.rows[0];

    if (!identity) {
      return burnPasswordCheck(password) || null;
    }

    if (!verifyPassword(password, identity.password_hash) || identity.status !== "active") {
      return null;
    }

    return findById(identity.user_id);
  }

  // Usernames of active students in the (unarchived) classes this user teaches.
  async function listStudentUsernamesForTeacher(userId) {
    const result = await pool.query(
      `
        SELECT DISTINCT s.username
        FROM class_members tm
        JOIN classes c ON c.id = tm.class_id AND c.archived_at IS NULL
        JOIN class_members sm ON sm.class_id = tm.class_id AND sm.member_role = 'student'
        JOIN users s ON s.id = sm.user_id
        WHERE tm.user_id = $1 AND tm.member_role = 'teacher'
      `,
      [userId],
    );
    return result.rows.map((row) => row.username);
  }

  async function recordLogin(userId) {
    await pool.query(
      `
        WITH updated AS (UPDATE users SET last_login_at = now() WHERE id = $1)
        UPDATE user_identities SET last_used_at = now()
        WHERE user_id = $1 AND provider = 'local'
      `,
      [userId],
    );
  }

  async function listAdminRoster() {
    const [usersResult, classesResult, teacherLinksResult, studentsResult] =
      await Promise.all([
        pool.query(`${userSelect} ORDER BY u.display_name, u.username`),
        pool.query(`
          SELECT c.id, c.name, t.username AS teacher_username, t.display_name AS teacher_name
          FROM classes c
          LEFT JOIN LATERAL (
            SELECT u.username, u.display_name
            FROM class_members m JOIN users u ON u.id = m.user_id
            WHERE m.class_id = c.id AND m.member_role = 'teacher'
            ORDER BY m.added_at, u.username
            LIMIT 1
          ) t ON true
          WHERE c.archived_at IS NULL
          ORDER BY c.name, c.id
        `),
        pool.query(`
          SELECT m.class_id, u.username
          FROM class_members m JOIN users u ON u.id = m.user_id
          WHERE m.member_role = 'teacher'
          ORDER BY m.added_at, u.username
        `),
        pool.query(`
          SELECT s.username, s.display_name, m.class_id, a.balance_cents, credited.credited_cents
          FROM users s
          JOIN user_roles r ON r.user_id = s.id AND r.role = 'student'
          LEFT JOIN class_members m ON m.user_id = s.id AND m.member_role = 'student'
          ${personalBudgetJoin}
          ORDER BY s.display_name, s.username
        `),
      ]);

    const users = usersResult.rows.map(mapUserRow);
    const hasRole = (role) => users.filter((user) => user.roles.includes(role));

    const classById = new Map(
      classesResult.rows.map((row) => [
        Number(row.id),
        {
          id: Number(row.id),
          className: row.name,
          teacherUsername: row.teacher_username ?? "",
          teacherFullName: row.teacher_name ?? "",
          students: [],
        },
      ]),
    );

    const teacherByUsername = new Map(
      hasRole("teacher").map((teacher) => [
        teacher.username,
        { username: teacher.username, fullName: teacher.fullName, className: "", students: [] },
      ]),
    );
    const classIdsByTeacher = new Map();

    for (const link of teacherLinksResult.rows) {
      const classItem = classById.get(Number(link.class_id));
      const teacher = teacherByUsername.get(link.username);
      if (!classItem || !teacher) {
        continue;
      }
      teacher.className ||= classItem.className;
      if (!classIdsByTeacher.has(link.username)) {
        classIdsByTeacher.set(link.username, new Set());
      }
      classIdsByTeacher.get(link.username).add(classItem.id);
    }

    for (const row of studentsResult.rows) {
      const classItem = classById.get(Number(row.class_id));
      const student = {
        username: row.username,
        fullName: row.display_name,
        teacherUsername: classItem?.teacherUsername ?? "",
        teacherFullName: classItem?.teacherFullName ?? "",
        ...mapStudentBudget(row),
        classId: classItem?.id ?? 0,
      };

      classItem?.students.push(student);

      for (const [teacherUsername, classIds] of classIdsByTeacher) {
        if (classItem && classIds.has(classItem.id)) {
          const teacherStudents = teacherByUsername.get(teacherUsername).students;
          if (!teacherStudents.some((existing) => existing.username === student.username)) {
            teacherStudents.push(student);
          }
        }
      }
    }

    return {
      stats: {
        userCount: users.length,
        teacherCount: hasRole("teacher").length,
        studentCount: hasRole("student").length,
        adminCount: hasRole("admin").length,
        classCount: classById.size,
      },
      admins: hasRole("admin").map((admin) => ({
        username: admin.username,
        fullName: admin.fullName,
      })),
      teachers: Array.from(teacherByUsername.values()),
      classes: Array.from(classById.values()),
    };
  }

  async function getTeacherRoster(username) {
    const teacher = await findByUsername(username);
    if (!teacher || !teacher.roles.includes("teacher")) {
      return null;
    }

    const [classResult, studentsResult, poolResult] = await Promise.all([
      pool.query(
        `
          SELECT c.name
          FROM class_members m JOIN classes c ON c.id = m.class_id
          WHERE m.user_id = $1 AND m.member_role = 'teacher' AND c.archived_at IS NULL
          ORDER BY m.added_at, c.id
          LIMIT 1
        `,
        [teacher.id],
      ),
      pool.query(
        `
          SELECT DISTINCT ON (s.display_name, s.username)
                 s.username, s.display_name, a.balance_cents, credited.credited_cents
          FROM class_members tm
          JOIN class_members sm ON sm.class_id = tm.class_id AND sm.member_role = 'student'
          JOIN classes c ON c.id = tm.class_id AND c.archived_at IS NULL
          JOIN users s ON s.id = sm.user_id
          ${personalBudgetJoin}
          WHERE tm.user_id = $1 AND tm.member_role = 'teacher'
          ORDER BY s.display_name, s.username
        `,
        [teacher.id],
      ),
      pool.query(
        "SELECT balance_cents FROM budget_accounts WHERE owner_user_id = $1 AND kind = 'teacher_pool'",
        [teacher.id],
      ),
    ]);

    return {
      teacher: {
        username: teacher.username,
        fullName: teacher.fullName,
        className: classResult.rows[0]?.name ?? "",
        poolBalance: centsToDollars(poolResult.rows[0]?.balance_cents ?? 0),
      },
      students: studentsResult.rows.map((row) => ({
        username: row.username,
        fullName: row.display_name,
        ...mapStudentBudget(row),
      })),
    };
  }

  return {
    findByCredentials,
    findByUsername,
    findById,
    recordLogin,
    listStudentUsernamesForTeacher,
    listAdminRoster,
    getTeacherRoster,
  };
}
