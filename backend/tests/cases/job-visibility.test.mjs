import { apiFetch, assert, createCookieJar, login } from "../lib/harness.mjs";

export const name = "students see only their own jobs; teachers see their students'; admins see all";

export async function run({ baseUrl }) {
  // Admin creates a job (owned by admin).
  const created = await apiFetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "admin-private", repo: "octocat/Hello-World" }),
  });
  const { job: adminJob } = await created.json();

  const student = createCookieJar();
  await login(student, baseUrl, "jane_smith", "talon123");
  const studentCreated = await student.fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "jane-job", repo: "octocat/Hello-World" }),
  });
  const { job: janeJob } = await studentCreated.json();

  const studentList = await (await student.fetch(`${baseUrl}/api/jobs?status=all`)).json();
  const studentOwners = new Set(studentList.items.map((item) => item.ownerUsername));
  assert(studentOwners.size === 1 && studentOwners.has("jane_smith"), `Student saw owners ${[...studentOwners]}`);

  // A job you cannot see reads as "no data" (200, like a stale reference), never the job.
  const peek = await student.fetch(`${baseUrl}/api/jobs/${adminJob.id}`);
  const peekBody = await peek.json().catch(() => ({}));
  assert(
    peek.status === 200 && peekBody.job === null && peekBody.execution === null && peekBody.noData === true
      && !JSON.stringify(peekBody).includes("admin-private"),
    `Student must not read another user's job: ${peek.status} ${JSON.stringify(peekBody)}`,
  );

  const hide = await student.fetch(`${baseUrl}/api/jobs/${adminJob.id}`, { method: "DELETE" });
  assert(hide.status === 404, `Student hiding admin job: expected 404, got ${hide.status}`);

  const results = await (await student.fetch(`${baseUrl}/api/results`)).json();
  assert(
    results.items.every((item) => item.ownerUsername === "jane_smith"),
    "Student saw another user's results",
  );

  // Teacher (talon_user teaches jane_smith in the demo seed) sees jane's job, not admin's.
  const teacher = createCookieJar();
  await login(teacher, baseUrl, "talon_user", "youwillneverguesswhereiwasyesterday");
  const teacherList = await (await teacher.fetch(`${baseUrl}/api/jobs?status=all`)).json();
  const teacherIds = new Set(teacherList.items.map((item) => item.id));
  assert(teacherIds.has(janeJob.id), "Teacher should see their student's job");
  assert(!teacherIds.has(adminJob.id), "Teacher must not see admin's job");

  const teacherCancel = await teacher.fetch(`${baseUrl}/api/jobs/${janeJob.id}/cancel`, { method: "POST" });
  assert(teacherCancel.status === 403, `Teacher cancelling student job: expected 403, got ${teacherCancel.status}`);

  const adminList = await (await apiFetch(`${baseUrl}/api/jobs?status=all`)).json();
  const adminIds = new Set(adminList.items.map((item) => item.id));
  assert(adminIds.has(adminJob.id) && adminIds.has(janeJob.id), "Admin should see all jobs");

  // Stop both (they may already have finished: the clone can fail fast).
  for (const [fetcher, id] of [[student.fetch, janeJob.id], [apiFetch, adminJob.id]]) {
    const stopped = await fetcher(`${baseUrl}/api/jobs/${id}/cancel`, { method: "POST" });
    assert(stopped.ok || stopped.status === 409, `cancel ${id}: ${stopped.status}`);
  }
}
