import { assert, createCookieJar, login } from "../lib/harness.mjs";

export const name = "admin user routes: an upper-case id is the same user (self checks, session revocation)";

const json = { "Content-Type": "application/json" };

async function send(jar, url, method, body) {
  const response = await jar.fetch(url, { method, headers: json, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, payload: await response.json().catch(() => ({})) };
}

export async function run({ baseUrl }) {
  const seeded = createCookieJar();
  await login(seeded, baseUrl, "admin", "admin123");

  // A second admin of its own, so the seeded admin is never at risk.
  const createdAdmin = await send(seeded, `${baseUrl}/api/admin/users`, "POST", { username: "case_admin", roles: ["admin"] });
  const createdStudent = await send(seeded, `${baseUrl}/api/admin/users`, "POST", { username: "case_student", roles: ["student"] });
  assert(createdAdmin.status === 201 && createdStudent.status === 201, "create users");

  const admin = createCookieJar();
  const adminOther = createCookieJar();
  await login(admin, baseUrl, "case_admin", createdAdmin.payload.password);
  await login(adminOther, baseUrl, "case_admin", createdAdmin.payload.password);
  const selfUrl = `${baseUrl}/api/admin/users/${createdAdmin.payload.id.toUpperCase()}`;

  // Self checks hold whatever the case of the id.
  const demote = await send(admin, selfUrl, "PATCH", { roles: ["teacher"] });
  assert(demote.status === 400, `dropping own admin role by upper-case id: expected 400, got ${demote.status}`);
  const disable = await send(admin, selfUrl, "PATCH", { status: "disabled" });
  assert(disable.status === 400, `disabling self by upper-case id: expected 400, got ${disable.status}`);
  assert((await admin.fetch(`${baseUrl}/api/admin/users`)).ok, "still an admin");

  // Reset another user's password: their live session ends.
  const student = createCookieJar();
  await login(student, baseUrl, "case_student", createdStudent.payload.password);
  assert((await student.fetch(`${baseUrl}/api/auth/me`)).ok, "student signed in");
  const reset = await send(admin, `${baseUrl}/api/admin/users/${createdStudent.payload.id.toUpperCase()}/reset-password`, "POST");
  assert(reset.status === 200 && reset.payload.password, `reset: ${reset.status}`);
  assert((await student.fetch(`${baseUrl}/api/auth/me`)).status === 401, "reset must sign the student out");
  assert((await login(createCookieJar(), baseUrl, "case_student", reset.payload.password)).ok, "new password works");

  // Reset own password: this session stays, the other one ends.
  const own = await send(admin, `${selfUrl}/reset-password`, "POST");
  assert(own.status === 200, `own reset: ${own.status}`);
  assert((await admin.fetch(`${baseUrl}/api/auth/me`)).ok, "the resetting session stays signed in");
  assert((await adminOther.fetch(`${baseUrl}/api/auth/me`)).status === 401, "the admin's other session is signed out");

  // Malformed ids reach the id guard (not just an unmatched route).
  const malformed = await send(admin, `${baseUrl}/api/admin/users/not-a-uuid`, "PATCH", { status: "active" });
  assert(malformed.status === 404, `malformed id: expected 404, got ${malformed.status}`);
}
