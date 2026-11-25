import { assert, createCookieJar, login } from "../lib/harness.mjs";

export const name = "canRunJobs: students and admins may submit jobs, a teacher-only account may not";

async function me(jar, baseUrl) {
  return (await (await jar.fetch(`${baseUrl}/api/auth/me`)).json()).user;
}

export async function run({ baseUrl }) {
  const student = createCookieJar();
  await login(student, baseUrl, "student_a1", "student123");
  assert((await me(student, baseUrl)).canRunJobs === true, "student should be able to run jobs");

  const admin = createCookieJar();
  await login(admin, baseUrl, "admin", "admin123");
  assert((await me(admin, baseUrl)).canRunJobs === true, "admin should be able to run jobs");

  const teacher = createCookieJar();
  await login(teacher, baseUrl, "teacher_ada", "teach123");
  assert((await me(teacher, baseUrl)).canRunJobs === false, "teacher-only account should not run jobs");

  const response = await teacher.fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "teacher-should-be-blocked", repo: "octocat/Hello-World" }),
  });
  assert(response.status === 403, `teacher submit: expected 403, got ${response.status}`);
}
