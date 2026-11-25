import { getPool } from "../../db/pool.js";
import { centsToDollars } from "../../budget/ledger.js";
import { burnPasswordCheck, verifyPassword } from "../../utils/passwords.js";
import { normalizeAvatar } from "talon-shared/avatars";

// Highest role wins for the single `role` field older callers still read.
const rolePrecedence = ["admin", "teacher", "student"];

function primaryRole(roles) {
  return rolePrecedence.find((role) => roles.includes(role)) || "student";
}

const userSelect = `
  SELECT u.id, u.username, u.display_name, u.email, u.status, u.can_run_jobs,
         u.storage_quota_bytes, u.storage_used_bytes, u.avatar_style, u.avatar_seed,
         ARRAY(SELECT r.role::text FROM user_roles r WHERE r.user_id = u.id ORDER BY r.role) AS roles,
         EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id = u.id AND i.provider = 'local') AS local_sign_in,
         EXISTS (SELECT 1 FROM class_members m JOIN classes c ON c.id = m.class_id
                 WHERE m.user_id = u.id AND c.archived_at IS NULL) AS in_class
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
    // False for users who only sign in with Microsoft (no Talon password).
    localSignIn: row.local_sign_in !== false,
    // A student in at least one active class (false: nobody has set them up yet).
    inClass: row.in_class === true,
    // The admin's job-running setting: true, false, or null for the role default.
    canRunJobsOverride: row.can_run_jobs ?? null,
    // { style, seed } the user picked, or null for initials.
    avatar: normalizeAvatar({ style: row.avatar_style, seed: row.avatar_seed }),
  };
}

// Legacy roster fields: `quota` = net funding of the personal account (grants,
// transfers and admin adjustments; not job charges or refunds), so money a
// teacher takes back lowers it; `tokensRemaining` = current balance. Dollars.
function mapStudentBudget(row) {
  return {
    quota: centsToDollars(row.credited_cents ?? 0),
    tokensRemaining: centsToDollars(row.balance_cents ?? 0),
  };
}

const personalBudgetJoin = `
  LEFT JOIN budget_accounts a ON a.owner_user_id = s.id AND a.kind = 'personal'
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(l.amount_cents) FILTER (WHERE l.kind IN ('grant', 'transfer', 'adjustment')), 0) AS credited_cents
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
      return (await burnPasswordCheck(password)) || null;
    }

    if (!(await verifyPassword(password, identity.password_hash)) || identity.status !== "active") {
      return null;
    }

    return findById(identity.user_id);
  }

  // Usernames of active students in the (unarchived) classes this user teaches.
  async function listStudentUsernamesForTeacher(userId) {
    const result = await pool.query(
      `
        SELECT DISTINCT s.username
        FROM classes c
        JOIN class_members sm ON sm.class_id = c.id
        JOIN users s ON s.id = sm.user_id
        WHERE c.teacher_id = $1 AND c.archived_at IS NULL
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

  // avatar: { style, seed } (already validated) or null to go back to initials.
  async function setAvatar(userId, avatar) {
    await pool.query("UPDATE users SET avatar_style = $2, avatar_seed = $3 WHERE id = $1", [
      userId,
      avatar?.style ?? null,
      avatar?.seed ?? null,
    ]);
  }

  async function listAdminRoster() {
    const [usersResult, classesResult, teacherLinksResult, studentsResult] =
      await Promise.all([
        pool.query(`${userSelect} ORDER BY u.display_name, u.username`),
        pool.query(`
          SELECT c.id, c.name, c.block, t.username AS teacher_username, t.display_name AS teacher_name
          FROM classes c
          LEFT JOIN users t ON t.id = c.teacher_id
          WHERE c.archived_at IS NULL
          ORDER BY lower(c.name), lower(c.block), c.id
        `),
        pool.query(`
          SELECT c.id AS class_id, t.username
          FROM classes c JOIN users t ON t.id = c.teacher_id
          WHERE c.archived_at IS NULL
          ORDER BY c.created_at, c.id
        `),
        pool.query(`
          SELECT s.username, s.display_name, m.class_id, a.balance_cents, credited.credited_cents
          FROM users s
          JOIN user_roles r ON r.user_id = s.id AND r.role = 'student'
          LEFT JOIN class_members m ON m.user_id = s.id
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
          block: row.block,
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

    const [classesResult, studentsResult, poolResult] = await Promise.all([
      pool.query(
        `
          SELECT c.id, c.name, c.block
          FROM classes c
          WHERE c.teacher_id = $1 AND c.archived_at IS NULL
          ORDER BY lower(c.block), lower(c.name), c.id
        `,
        [teacher.id],
      ),
      pool.query(
        `
          SELECT c.id AS class_id, s.username, s.display_name, s.avatar_style, s.avatar_seed, a.balance_cents, credited.credited_cents
          FROM classes c
          JOIN class_members sm ON sm.class_id = c.id
          JOIN users s ON s.id = sm.user_id
          ${personalBudgetJoin}
          WHERE c.teacher_id = $1 AND c.archived_at IS NULL
          ORDER BY s.display_name, s.username
        `,
        [teacher.id],
      ),
      pool.query(
        "SELECT balance_cents FROM budget_accounts WHERE owner_user_id = $1 AND kind = 'teacher_pool'",
        [teacher.id],
      ),
    ]);

    const mapStudent = (row) => ({
      username: row.username,
      fullName: row.display_name,
      avatar: normalizeAvatar({ style: row.avatar_style, seed: row.avatar_seed }),
      ...mapStudentBudget(row),
    });

    // One entry per class the teacher teaches; a student in two of their
    // classes appears in both. `students` is the same people, once each.
    const classes = classesResult.rows.map((row) => ({
      id: Number(row.id),
      className: row.name,
      block: row.block,
      students: studentsResult.rows
        .filter((student) => Number(student.class_id) === Number(row.id))
        .map(mapStudent),
    }));
    const distinctStudents = new Map();
    for (const row of studentsResult.rows) {
      distinctStudents.set(row.username, mapStudent(row));
    }

    return {
      teacher: {
        username: teacher.username,
        fullName: teacher.fullName,
        className: classesResult.rows[0]?.name ?? "",
        poolBalance: centsToDollars(poolResult.rows[0]?.balance_cents ?? 0),
        // The teacher's own budget (what their jobs spend), funded from the pool.
        ownBalance: await getPersonalBalanceDollars(teacher.id),
      },
      classes,
      students: [...distinctStudents.values()],
    };
  }

  async function getPersonalBalanceDollars(userId) {
    const result = await pool.query(
      "SELECT balance_cents FROM budget_accounts WHERE owner_user_id = $1 AND kind = 'personal'",
      [userId],
    );
    return centsToDollars(result.rows[0]?.balance_cents ?? 0);
  }

  return {
    findByCredentials,
    findByUsername,
    findById,
    recordLogin,
    setAvatar,
    listStudentUsernamesForTeacher,
    listAdminRoster,
    getTeacherRoster,
    getPersonalBalanceDollars,
  };
}
