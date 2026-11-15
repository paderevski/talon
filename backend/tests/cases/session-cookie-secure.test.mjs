import { assert, startBackendForTests } from "../lib/harness.mjs";
import { sessionCookieSecure } from "../../src/auth/session.js";

export const name = "session cookie: Secure over HTTPS (X-Forwarded-Proto), still works over the plain-HTTP tunnel";

async function loginCookie(baseUrl, proto) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-Proto": proto },
    body: JSON.stringify({ username: "student_a1", password: "student123" }),
  });
  assert(response.ok, `login over ${proto}: ${response.status}`);
  const cookie = (response.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("talon.sid="));
  assert(cookie, `login over ${proto} set no session cookie`);
  return cookie;
}

export async function run() {
  assert(sessionCookieSecure({ NODE_ENV: "production" }) === "auto", "production defaults to auto");
  assert(sessionCookieSecure({}) === false, "development defaults to off");
  assert(sessionCookieSecure({ NODE_ENV: "production", SESSION_COOKIE_SECURE: "true" }) === true, "true forces Secure");
  assert(sessionCookieSecure({ NODE_ENV: "production", SESSION_COOKIE_SECURE: "false" }) === false, "false turns it off");

  // The backend is called from loopback, like nginx calls it, so it trusts
  // X-Forwarded-Proto (the ALB's value, passed on by nginx).
  const server = await startBackendForTests({ env: { SESSION_COOKIE_SECURE: "auto" }, reset: false });
  try {
    const https = await loginCookie(server.baseUrl, "https");
    assert(/;\s*Secure/i.test(https), `HTTPS login cookie should be Secure: ${https}`);
    const http = await loginCookie(server.baseUrl, "http");
    assert(!/;\s*Secure/i.test(http), `tunnel (HTTP) login cookie should not be Secure: ${http}`);
  } finally {
    await server.stop();
  }
}
