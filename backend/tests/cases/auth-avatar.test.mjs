import { assert, createCookieJar, login } from "../lib/harness.mjs";

export const name = "avatar: a user picks an allowed style or goes back to initials";

const json = { "Content-Type": "application/json" };

export async function run({ baseUrl }) {
  // A user of its own, so no other test sees its avatar.
  const admin = createCookieJar();
  await login(admin, baseUrl, "admin", "admin123");
  const created = await admin.fetch(`${baseUrl}/api/admin/users`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ username: "avatar_user", roles: ["student"] }),
  });
  const { password } = await created.json();
  assert(created.status === 201 && password, `create user ${created.status}`);

  const user = createCookieJar();
  const signedIn = await login(user, baseUrl, "avatar_user", password);
  assert(signedIn.ok, "sign in");
  assert((await signedIn.json()).user.avatar === null, "no avatar by default (initials)");

  const put = (jar, body) =>
    jar.fetch(`${baseUrl}/api/auth/avatar`, { method: "PUT", headers: json, body: JSON.stringify(body) });

  const anonymous = await put(createCookieJar(), { avatar: { style: "bottts", seed: "abc" } });
  assert(anonymous.status === 401, `anonymous: expected 401, got ${anonymous.status}`);

  for (const avatar of [
    { style: "not-a-style", seed: "abc" },
    { style: "bottts", seed: "" },
    { style: "bottts", seed: "<script>" },
    { style: "bottts", seed: "x".repeat(33) },
    "bottts",
  ]) {
    const response = await put(user, { avatar });
    assert(response.status === 400, `${JSON.stringify(avatar)}: expected 400, got ${response.status}`);
  }

  const set = await put(user, { avatar: { style: "bottts", seed: "Robo_7-x", extra: "ignored" } });
  assert(set.ok, `set: ${set.status} ${await set.clone().text()}`);
  const setBody = await set.json();
  assert(setBody.user.avatar?.style === "bottts" && setBody.user.avatar?.seed === "Robo_7-x", "set answers the user");
  assert(setBody.user.avatar.extra === undefined, "only style and seed are kept");

  const me = await (await user.fetch(`${baseUrl}/api/auth/me`)).json();
  assert(me.user.avatar?.style === "bottts" && me.user.avatar?.seed === "Robo_7-x", "me shows the avatar");

  // Lists show it next to the name.
  const { users } = await (await admin.fetch(`${baseUrl}/api/admin/users`)).json();
  const listed = users.find((item) => item.username === "avatar_user");
  assert(listed?.avatar?.style === "bottts" && listed.avatar.seed === "Robo_7-x", "admin user list has the avatar");
  assert(users.find((item) => item.username === "admin")?.avatar === null, "others still show initials");

  const cleared = await put(user, { avatar: null });
  assert(cleared.ok && (await cleared.json()).user.avatar === null, "cleared back to initials");
}
