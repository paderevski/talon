import { assert, createCookieJar, login, withTestDb } from "../lib/harness.mjs";

export const name = "admin budget panel: user details, and funding a student from their teacher's pool";

export async function run({ baseUrl }) {
  // A student in an active class, that class's teacher, and another teacher.
  const ids = await withTestDb(async (pool) => {
    const { rows } = await pool.query(
      `SELECT m.user_id AS student_id, s.username AS student, c.teacher_id,
              (SELECT u.id FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'teacher'
               WHERE u.id <> c.teacher_id
                 AND NOT EXISTS (SELECT 1 FROM classes c2 JOIN class_members m2 ON m2.class_id = c2.id
                                 WHERE c2.teacher_id = u.id AND m2.user_id = m.user_id AND c2.archived_at IS NULL)
               LIMIT 1) AS other_teacher_id
       FROM class_members m
       JOIN classes c ON c.id = m.class_id AND c.archived_at IS NULL AND c.teacher_id IS NOT NULL
       JOIN users s ON s.id = m.user_id AND s.status = 'active'
       LIMIT 1`,
    );
    return rows[0];
  });
  assert(ids?.student_id && ids.teacher_id, "Expected a seeded student in a class with a teacher");

  const admin = createCookieJar();
  await login(admin, baseUrl, "admin", "admin123");

  const student = createCookieJar();
  await login(student, baseUrl, "student_a1", "student123");
  const forbidden = await student.fetch(`${baseUrl}/api/admin/users/${ids.student_id}/budget`);
  assert(forbidden.status === 403, `Expected student 403, got ${forbidden.status}`);

  const details = async () => {
    const response = await admin.fetch(`${baseUrl}/api/admin/users/${ids.student_id}/budget`);
    assert(response.ok, `Expected details 200, got ${response.status}`);
    return response.json();
  };
  const before = await details();
  const teacher = before.teachers.find((candidate) => candidate.id === ids.teacher_id);
  assert(teacher, "Expected the class teacher among the student's teachers");
  assert(Array.isArray(teacher.classes) && teacher.classes[0]?.name, "Expected the teacher's classes");
  assert(typeof before.school === "number" && typeof before.personal.balance === "number", "Expected balances");
  assert(before.pool === null, "A student has no pool");

  // Make sure the pool can give $1, from School.
  const adjust = (body) =>
    admin.fetch(`${baseUrl}/api/admin/budget/adjustments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const fundPool = await adjust({ userId: ids.teacher_id, target: "pool", direction: "increase", amount: 1 });
  assert(fundPool.status === 201, `Expected pool funding 201, got ${fundPool.status}`);
  const poolBefore = (await details()).teachers.find((candidate) => candidate.id === ids.teacher_id).poolBalance;

  const give = await adjust({ userId: ids.student_id, target: "personal", direction: "increase", amount: 1, fromTeacherId: ids.teacher_id });
  assert(give.status === 201, `Expected pool -> student 201, got ${give.status}`);
  const after = await details();
  const poolAfter = after.teachers.find((candidate) => candidate.id === ids.teacher_id).poolBalance;
  assert(Math.abs(poolBefore - 1 - poolAfter) < 1e-9, `pool ${poolBefore} -> ${poolAfter}, expected -1`);
  assert(Math.abs(before.personal.balance + 1 - after.personal.balance) < 1e-9, "Expected the student's budget up by $1");
  assert(after.personal.receivedThisYear >= before.personal.receivedThisYear + 1 - 1e-9, "Expected $1 more received this year");
  assert(Math.abs(after.school - (before.school - 1)) < 1e-9, "Only the pool funding came from School");

  const back = await adjust({ userId: ids.student_id, target: "personal", direction: "decrease", amount: 1, fromTeacherId: ids.teacher_id });
  assert(back.status === 201, `Expected student -> pool 201, got ${back.status}`);
  const restored = (await details()).teachers.find((candidate) => candidate.id === ids.teacher_id).poolBalance;
  assert(Math.abs(restored - poolBefore) < 1e-9, "Expected the dollar back in the pool");

  if (ids.other_teacher_id) {
    const wrong = await adjust({ userId: ids.student_id, target: "personal", direction: "increase", amount: 1, fromTeacherId: ids.other_teacher_id });
    assert(wrong.status === 400, `Expected a teacher who does not teach the student to be refused, got ${wrong.status}`);
  }
  const poolTarget = await adjust({ userId: ids.teacher_id, target: "pool", direction: "increase", amount: 1, fromTeacherId: ids.teacher_id });
  assert(poolTarget.status === 400, `Expected pool target with a teacher source to be refused, got ${poolTarget.status}`);

  const missing = await admin.fetch(`${baseUrl}/api/admin/users/00000000-0000-0000-0000-000000000000/budget`);
  assert(missing.status === 404, `Expected unknown user 404, got ${missing.status}`);
}
