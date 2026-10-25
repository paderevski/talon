import { assert, createCookieJar, login } from "../lib/harness.mjs";

export const name = "auth session: login sets cookie, /me, logout";

export async function run({ baseUrl }) {
  const jar = createCookieJar();

  const anonymous = await jar.fetch(`${baseUrl}/api/auth/me`);
  assert(anonymous.status === 401, `Expected anonymous /me 401, got ${anonymous.status}`);

  const failed = await login(jar, baseUrl, "jane_smith", "wrong-password");
  assert(failed.status === 401, `Expected bad password 401, got ${failed.status}`);
  assert(!jar.get("talon.sid"), "Failed login must not set a session cookie");

  const response = await login(jar, baseUrl, "jane_smith", "talon123");
  assert(response.ok, `Expected login 200, got ${response.status}`);
  const setCookie = response.headers.getSetCookie().find((value) => value.startsWith("talon.sid="));
  assert(setCookie, "Expected talon.sid cookie");
  assert(/HttpOnly/i.test(setCookie), "Session cookie must be HttpOnly");
  assert(/SameSite=Lax/i.test(setCookie), "Session cookie must be SameSite=Lax");

  const me = await jar.fetch(`${baseUrl}/api/auth/me`);
  assert(me.ok, `Expected /me 200, got ${me.status}`);
  const payload = await me.json();
  assert(payload?.user?.username === "jane_smith", `Expected jane_smith, got ${payload?.user?.username}`);
  assert(Array.isArray(payload?.user?.roles), "Expected roles[]");

  const firstSessionCookie = jar.get("talon.sid");
  await login(jar, baseUrl, "admin", "admin123");
  assert(jar.get("talon.sid") !== firstSessionCookie, "Login must issue a new session id");

  const logout = await jar.fetch(`${baseUrl}/api/auth/logout`, { method: "POST" });
  assert(logout.ok, `Expected logout 200, got ${logout.status}`);

  const replay = createCookieJar();
  replay.set("talon.sid", firstSessionCookie);
  const replayed = await replay.fetch(`${baseUrl}/api/auth/me`);
  assert(replayed.status === 401, `Expected replaced session to be invalid, got ${replayed.status}`);

  const afterLogout = await jar.fetch(`${baseUrl}/api/auth/me`);
  assert(afterLogout.status === 401, `Expected /me 401 after logout, got ${afterLogout.status}`);
}
