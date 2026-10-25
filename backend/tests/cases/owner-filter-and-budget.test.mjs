import { assert, createCookieJar, login } from "../lib/harness.mjs";

export const name = "?owner= narrows jobs and results within scope, never beyond it; /me shows budget";

async function ownersOf(jar, url) {
  const response = await jar.fetch(url);
  assert(response.ok, `${url} returned ${response.status}`);
  const body = await response.json();
  return (body.items || []).map((item) => item.ownerUsername);
}

export async function run({ baseUrl }) {
  // teacher_ada teaches student_a1..a5 (seeded jobs for each).
  const teacher = createCookieJar();
  await login(teacher, baseUrl, "teacher_ada", "teach123");

  const all = await ownersOf(teacher, `${baseUrl}/api/jobs?status=all`);
  assert(new Set(all).size > 1, "teacher should see several students' jobs without a filter");

  const one = await ownersOf(teacher, `${baseUrl}/api/jobs?status=all&owner=student_a1`);
  assert(one.length > 0 && one.every((owner) => owner === "student_a1"), `owner filter: ${one}`);

  const outside = await ownersOf(teacher, `${baseUrl}/api/jobs?status=all&owner=student_g1`);
  assert(outside.length === 0, "a student outside the teacher's classes must stay invisible");

  const results = await ownersOf(teacher, `${baseUrl}/api/results?owner=student_a2`);
  assert(results.length > 0 && results.every((owner) => owner === "student_a2"), `results owner filter: ${results}`);

  // A student cannot widen their own view with ?owner=.
  const student = createCookieJar();
  await login(student, baseUrl, "student_a1", "student123");
  const others = await ownersOf(student, `${baseUrl}/api/jobs?status=all&owner=student_a2`);
  assert(others.length === 0, "a student must not see another student via ?owner=");

  const me = await (await student.fetch(`${baseUrl}/api/auth/me`)).json();
  assert(typeof me.user.budgetBalance === "number" && me.user.budgetBalance >= 0, `budgetBalance: ${me.user.budgetBalance}`);
}
