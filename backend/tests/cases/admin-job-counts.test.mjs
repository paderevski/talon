import { assert, createCookieJar, login, withTestDb } from "../lib/harness.mjs";

export const name = "admin job counts require admin and match the visible jobs";

export async function run({ baseUrl }) {
  const anonymous = await fetch(`${baseUrl}/api/admin/job-counts`);
  assert(anonymous.status === 401, `Expected anonymous 401, got ${anonymous.status}`);

  const student = createCookieJar();
  await login(student, baseUrl, "student_a1", "student123");
  const forbidden = await student.fetch(`${baseUrl}/api/admin/job-counts`);
  assert(forbidden.status === 403, `Expected student 403, got ${forbidden.status}`);

  const admin = createCookieJar();
  await login(admin, baseUrl, "admin", "admin123");
  const response = await admin.fetch(`${baseUrl}/api/admin/job-counts`);
  assert(response.ok, `Expected admin 200, got ${response.status}`);
  const counts = await response.json();

  // Other tests add and hide jobs, so compare with the table rather than fixed numbers.
  const expected = await withTestDb(async (pool) => {
    const { rows } = await pool.query(
      `SELECT count(*) FILTER (WHERE status = 'running')::int AS running,
              count(*) FILTER (WHERE status = 'queued')::int AS queued,
              count(*)::int AS total
       FROM jobs WHERE NOT hidden`,
    );
    return rows[0];
  });
  assert(counts.running === expected.running, `running ${counts.running}, expected ${expected.running}`);
  assert(counts.queued === expected.queued, `queued ${counts.queued}, expected ${expected.queued}`);
  assert(counts.total === expected.total, `total ${counts.total}, expected ${expected.total}`);
}
