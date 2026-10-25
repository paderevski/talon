import { assert, createCookieJar, login } from "../lib/harness.mjs";

export const name = "x-talon-user header grants nothing; job owner comes from the session";

export async function run({ baseUrl }) {
  // No session + spoofed header: still anonymous.
  for (const path of ["/api/admin/roster", "/api/teacher/students", "/api/jobs", "/api/results"]) {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { "x-talon-user": path.includes("teacher") ? "talon_user" : "admin" },
    });
    assert(response.status === 401, `${path} with spoofed header: expected 401, got ${response.status}`);
  }

  // Student session + header claiming admin: still a student.
  const student = createCookieJar();
  await login(student, baseUrl, "jane_smith", "talon123");
  const escalate = await student.fetch(`${baseUrl}/api/admin/roster`, {
    headers: { "x-talon-user": "admin" },
  });
  assert(escalate.status === 403, `Student + admin header: expected 403, got ${escalate.status}`);

  // ownerUsername in the body is ignored.
  const created = await student.fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-talon-user": "admin" },
    body: JSON.stringify({ name: "spoof-check", repo: "octocat/Hello-World", ownerUsername: "admin" }),
  });
  assert(created.status === 201, `Expected job create 201, got ${created.status}`);
  const { job } = await created.json();
  assert(job.ownerUsername === "jane_smith", `Expected owner jane_smith, got ${job.ownerUsername}`);

  // Cancel it so it doesn't linger.
  await student.fetch(`${baseUrl}/api/jobs/${job.id}/cancel`, { method: "POST" });
}
