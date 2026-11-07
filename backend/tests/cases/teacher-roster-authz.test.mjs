import { assert, createCookieJar, login, withTestDb } from "../lib/harness.mjs";

export const name = "teacher roster requires teacher and returns class students";

export async function run({ baseUrl }) {
  const admin = createCookieJar();
  await login(admin, baseUrl, "admin", "admin123");
  const forbiddenResponse = await admin.fetch(`${baseUrl}/api/teacher/students`);
  assert(
    forbiddenResponse.status === 403,
    `Expected admin access to be rejected with 403, got ${forbiddenResponse.status}`,
  );

  const teacher = createCookieJar();
  await login(teacher, baseUrl, "talon_user", "youwillneverguesswhereiwasyesterday");
  const response = await teacher.fetch(`${baseUrl}/api/teacher/students`);
  assert(response.ok, `Expected teacher roster 200, got ${response.status}`);

  const payload = await response.json();
  assert(payload?.ok === true, "Expected teacher roster payload ok=true");
  assert(payload?.roster?.teacher?.username === "talon_user", "Expected teacher roster to identify talon_user");
  assert(payload?.roster?.teacher?.className === "ML Foundations", "Expected teacher roster to include class name");
  // The students of talon_user's active classes, read from the database now.
  const expected = await withTestDb(async (pool) => (await pool.query(
    `SELECT u.username FROM class_members m
       JOIN classes c ON c.id = m.class_id
       JOIN users t ON t.id = c.teacher_id
       JOIN users u ON u.id = m.user_id
      WHERE t.username = 'talon_user' AND c.archived_at IS NULL
      ORDER BY u.username`,
  )).rows.map((row) => row.username));
  const listed = (payload?.roster?.students ?? []).map((student) => student.username).sort();
  assert(expected.length >= 1 && JSON.stringify(listed) === JSON.stringify(expected), `students ${listed}, expected ${expected}`);
}
