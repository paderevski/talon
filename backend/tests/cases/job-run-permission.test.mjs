import { assert, createCookieJar, login } from "../lib/harness.mjs";

export const name = "canRunJobs: role default (students and admins yes, teachers no), and the admin's per-user setting";

const json = { "Content-Type": "application/json" };

async function me(jar, baseUrl) {
  return (await (await jar.fetch(`${baseUrl}/api/auth/me`)).json()).user;
}

async function submit(jar, baseUrl, name) {
  return jar.fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ name, repo: "octocat/Hello-World" }),
  });
}

export async function run({ baseUrl }) {
  const admin = createCookieJar();
  await login(admin, baseUrl, "admin", "admin123");
  assert((await me(admin, baseUrl)).canRunJobs === true, "admin should be able to run jobs");

  const student = createCookieJar();
  await login(student, baseUrl, "student_a1", "student123");
  assert((await me(student, baseUrl)).canRunJobs === true, "student should be able to run jobs");

  const teacher = createCookieJar();
  await login(teacher, baseUrl, "teacher_ada", "teach123");
  assert((await me(teacher, baseUrl)).canRunJobs === false, "teacher-only account should not run jobs");
  const teacherSubmit = await submit(teacher, baseUrl, "teacher-should-be-blocked");
  assert(teacherSubmit.status === 403, `teacher submit: expected 403, got ${teacherSubmit.status}`);

  const users = (await (await admin.fetch(`${baseUrl}/api/admin/users`)).json()).users;
  const idOf = (username) => users.find((user) => user.username === username).id;
  const listed = users.find((user) => user.username === "teacher_ada");
  assert(listed.canRunJobsOverride === null && listed.canRunJobs === false, "user list: teacher default");

  const setCanRun = (username, value) =>
    admin.fetch(`${baseUrl}/api/admin/users/${idOf(username)}`, {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({ canRunJobs: value }),
    });

  try {
    const bad = await setCanRun("student_a1", "yes");
    assert(bad.status === 400, `a non-boolean setting should be refused, got ${bad.status}`);

    // Blocked student: takes effect on their next request, budget untouched.
    assert((await setCanRun("student_a1", false)).ok, "block student");
    assert((await me(student, baseUrl)).canRunJobs === false, "blocked student: /me");
    const blocked = await submit(student, baseUrl, "blocked-student");
    assert(blocked.status === 403, `blocked student submit: expected 403, got ${blocked.status}`);

    // Allowed teacher: the role check no longer refuses them.
    assert((await setCanRun("teacher_ada", true)).ok, "allow teacher");
    assert((await me(teacher, baseUrl)).canRunJobs === true, "allowed teacher: /me");
    const allowed = await submit(teacher, baseUrl, "allowed-teacher");
    assert(allowed.status !== 403, `allowed teacher submit should not be 403, got ${allowed.status}`);
  } finally {
    await setCanRun("student_a1", null);
    await setCanRun("teacher_ada", null);
  }

  assert((await me(student, baseUrl)).canRunJobs === true, "back to the role default");
}
