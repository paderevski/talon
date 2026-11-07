import { assert, createCookieJar, login, withTestDb } from "../lib/harness.mjs";

export const name = "admin roster requires admin and returns seeded roster";

export async function run({ baseUrl }) {
  const anonymous = await fetch(`${baseUrl}/api/admin/roster`);
  assert(anonymous.status === 401, `Expected anonymous 401, got ${anonymous.status}`);

  const teacher = createCookieJar();
  await login(teacher, baseUrl, "talon_user", "youwillneverguesswhereiwasyesterday");
  const forbiddenResponse = await teacher.fetch(`${baseUrl}/api/admin/roster`);
  assert(
    forbiddenResponse.status === 403,
    `Expected teacher access to be rejected with 403, got ${forbiddenResponse.status}`,
  );

  const admin = createCookieJar();
  await login(admin, baseUrl, "admin", "admin123");
  const response = await admin.fetch(`${baseUrl}/api/admin/roster`);
  assert(response.ok, `Expected admin roster 200, got ${response.status}`);

  const payload = await response.json();
  assert(payload?.ok === true, "Expected roster payload ok=true");
  // Counted from the database now, so tests that add users may run first.
  const expected = await withTestDb(async (pool) => {
    const { rows } = await pool.query("SELECT role, count(DISTINCT user_id)::int AS n FROM user_roles GROUP BY role");
    return Object.fromEntries(rows.map((row) => [row.role, row.n]));
  });
  const stats = payload?.roster?.stats ?? {};
  assert(stats.adminCount === expected.admin && expected.admin >= 1, `admins ${stats.adminCount}, expected ${expected.admin}`);
  assert(stats.teacherCount === expected.teacher && expected.teacher >= 1, `teachers ${stats.teacherCount}, expected ${expected.teacher}`);
  assert(stats.studentCount === expected.student && expected.student >= 1, `students ${stats.studentCount}, expected ${expected.student}`);
  assert(Array.isArray(payload?.roster?.teachers), "Expected teachers[] in roster payload");
  assert(payload.roster.teachers.length === expected.teacher, `teacher records ${payload.roster.teachers.length}, expected ${expected.teacher}`);
}
