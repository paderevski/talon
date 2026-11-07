import { assert, createCookieJar, login } from "../lib/harness.mjs";

export const name = "password change: trimmed like login, signs out the user's other sessions";

const json = { "Content-Type": "application/json" };

export async function run({ baseUrl }) {
  // A user of its own, so no other test depends on its password.
  const admin = createCookieJar();
  await login(admin, baseUrl, "admin", "admin123");
  const created = await admin.fetch(`${baseUrl}/api/admin/users`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ username: "pw_change_user", roles: ["student"] }),
  });
  const { password } = await created.json();
  assert(created.status === 201 && password, `create user ${created.status}`);

  const first = createCookieJar();
  const second = createCookieJar();
  assert((await login(first, baseUrl, "pw_change_user", password)).ok, "first sign-in");
  assert((await login(second, baseUrl, "pw_change_user", password)).ok, "second sign-in");

  const anonymous = await createCookieJar().fetch(`${baseUrl}/api/auth/password`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ currentPassword: password, newPassword: "whatever-pass1" }),
  });
  assert(anonymous.status === 401, `anonymous change: expected 401, got ${anonymous.status}`);

  // Padded with spaces: login trims, so the change must too.
  const changed = await first.fetch(`${baseUrl}/api/auth/password`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ currentPassword: password, newPassword: "  padded-pass1  " }),
  });
  assert(changed.ok, `change: ${changed.status} ${await changed.text()}`);

  assert((await first.fetch(`${baseUrl}/api/auth/me`)).status === 200, "the session that changed it stays signed in");
  assert((await second.fetch(`${baseUrl}/api/auth/me`)).status === 401, "other sessions are signed out");

  for (const typed of ["padded-pass1", "  padded-pass1  "]) {
    const response = await login(createCookieJar(), baseUrl, "pw_change_user", typed);
    assert(response.ok, `sign in with '${typed}': expected 200, got ${response.status}`);
  }

  // Spaces do not count towards the minimum length.
  const short = await first.fetch(`${baseUrl}/api/auth/password`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ currentPassword: "padded-pass1", newPassword: "  short1  " }),
  });
  assert(short.status === 400, `short padded password: expected 400, got ${short.status}`);
}
