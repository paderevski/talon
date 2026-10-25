import { assert, createCookieJar, login } from "../lib/harness.mjs";

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
  assert(payload?.roster?.stats?.adminCount === 1, "Expected one admin in roster stats");
  assert(payload?.roster?.stats?.teacherCount === 4, "Expected four teachers in roster stats");
  assert(payload?.roster?.stats?.studentCount === 16, "Expected sixteen students in roster stats");
  assert(Array.isArray(payload?.roster?.teachers), "Expected teachers[] in roster payload");
  assert(payload.roster.teachers.length === 4, "Expected four teacher records in roster payload");
}
