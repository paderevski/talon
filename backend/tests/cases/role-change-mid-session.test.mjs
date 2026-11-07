import { assert, createCookieJar, login } from "../lib/harness.mjs";

export const name = "role changes take effect on the user's next request, without signing in again";

const json = { "Content-Type": "application/json" };

export async function run({ baseUrl }) {
  const admin = createCookieJar();
  await login(admin, baseUrl, "admin", "admin123");
  const created = await (await admin.fetch(`${baseUrl}/api/admin/users`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ username: "role_change_user", roles: ["teacher", "admin"] }),
  })).json();
  assert(created.id, "create user");

  const user = createCookieJar();
  await login(user, baseUrl, "role_change_user", created.password);
  assert((await user.fetch(`${baseUrl}/api/admin/users`)).ok, "admin route before the change");
  assert((await user.fetch(`${baseUrl}/api/teacher/students`)).ok, "teacher route before the change");

  const patch = await admin.fetch(`${baseUrl}/api/admin/users/${created.id}`, {
    method: "PATCH",
    headers: json,
    body: JSON.stringify({ roles: ["teacher"] }),
  });
  assert(patch.ok, `drop admin role: ${patch.status}`);

  // Same session, next request: admin is gone, teacher remains.
  const adminRoute = await user.fetch(`${baseUrl}/api/admin/users`);
  assert(adminRoute.status === 403, `admin route after the change: expected 403, got ${adminRoute.status}`);
  assert((await user.fetch(`${baseUrl}/api/teacher/students`)).ok, "teacher route after the change");
  const me = await (await user.fetch(`${baseUrl}/api/auth/me`)).json();
  assert(JSON.stringify(me.user.roles) === '["teacher"]', `roles shown ${JSON.stringify(me.user.roles)}`);
}
