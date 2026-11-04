import { assert, createCookieJar, login } from "../lib/harness.mjs";

export const name = "github app routes: sign-in required, off when not configured, callback checks state";

export async function run({ baseUrl }) {
  const anonymous = await fetch(`${baseUrl}/api/github`);
  assert(anonymous.status === 401, `Expected anonymous 401, got ${anonymous.status}`);

  // The callback is a browser navigation: it redirects, never answers 401.
  const anonymousCallback = await fetch(`${baseUrl}/api/github/callback?code=x&state=y`, { redirect: "manual" });
  assert(anonymousCallback.status === 303, `Expected callback redirect, got ${anonymousCallback.status}`);
  assert(/github=signed-out/.test(anonymousCallback.headers.get("location") || ""), "anonymous callback should say signed-out");

  const jar = createCookieJar();
  await login(jar, baseUrl, "jane_smith", "talon123");
  const status = await jar.fetch(`${baseUrl}/api/github`);
  assert(status.ok, `Expected status 200, got ${status.status}`);
  const payload = await status.json();
  assert(payload.configured === false && payload.linked === false && payload.login === "", `status ${JSON.stringify(payload)}`);

  const connect = await jar.fetch(`${baseUrl}/api/github/connect`, { redirect: "manual" });
  assert(connect.status === 303 && /github=not-configured/.test(connect.headers.get("location") || ""), "connect without an app should say not-configured");

  // No state in the session (or a wrong one): refused before any GitHub call.
  const forged = await jar.fetch(`${baseUrl}/api/github/callback?code=attacker-code&state=guess`, { redirect: "manual" });
  assert(forged.status === 303 && /github=state/.test(forged.headers.get("location") || ""), `forged callback: ${forged.headers.get("location")}`);

  const repos = await jar.fetch(`${baseUrl}/api/github/repos`);
  assert(repos.status === 503, `Expected 503 for repos without an app, got ${repos.status}`);

  const unlink = await jar.fetch(`${baseUrl}/api/github`, { method: "DELETE" });
  assert(unlink.ok, `Expected unlink 200, got ${unlink.status}`);

  const oldRoute = await jar.fetch(`${baseUrl}/api/github-credentials`);
  assert(oldRoute.status === 404, `PAT endpoint should be gone, got ${oldRoute.status}`);
}
