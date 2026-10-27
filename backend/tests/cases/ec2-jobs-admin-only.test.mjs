import { assert, createCookieJar, login } from "../lib/harness.mjs";

export const name = "EC2 jobs are admin-only and need to be enabled; nothing is created otherwise";

export async function run({ baseUrl }) {
  const post = (jar, body) =>
    jar.fetch(`${baseUrl}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const student = createCookieJar();
  await login(student, baseUrl, "student_a1", "student123");
  const asStudent = await post(student, { name: "sneaky", repo: "octocat/Hello-World", compute: "ec2" });
  assert(asStudent.status === 403, `Expected 403 for a student asking for EC2, got ${asStudent.status}`);

  const admin = createCookieJar();
  await login(admin, baseUrl, "admin", "admin123");
  const notEnabled = await post(admin, { name: "not-enabled", repo: "octocat/Hello-World", compute: "ec2" });
  assert(notEnabled.status === 503, `Expected 503 when EC2 jobs are not enabled, got ${notEnabled.status}`);

  const jobs = await (await admin.fetch(`${baseUrl}/api/jobs?includeHidden=true`)).json();
  const created = jobs.items.filter((job) => ["sneaky", "not-enabled"].includes(job.name));
  assert(created.length === 0, "A refused EC2 request must not create a job");

  const options = await (await student.fetch(`${baseUrl}/api/jobs/compute-options`)).json();
  assert(options.ec2.enabled === false && options.ec2.options.length === 0, `Students are offered no EC2 options: ${JSON.stringify(options)}`);
}
