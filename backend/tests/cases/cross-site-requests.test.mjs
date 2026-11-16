import { assert, createCookieJar, login } from "../lib/harness.mjs";

export const name = "state-changing API requests marked cross-site by the browser are refused";

export async function run({ baseUrl }) {
  const host = new URL(baseUrl).host;
  const jar = createCookieJar();
  assert((await login(jar, baseUrl, "student_a2", "student123")).ok, "sign in");

  // The forged request: an empty text/plain POST to a route that needs no body.
  const post = (headers) =>
    jar.fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: { "Content-Type": "text/plain", ...headers } });
  const status = async (headers) => (await post(headers)).status;
  const stillSignedIn = async () => (await jar.fetch(`${baseUrl}/api/auth/me`)).status === 200;

  for (const headers of [
    { Origin: "https://evil.example.org" },
    { Origin: "null" },
    { "Sec-Fetch-Site": "same-site" },
    { "Sec-Fetch-Site": "cross-site" },
    // Sec-Fetch-Site wins over a matching Origin.
    { "Sec-Fetch-Site": "cross-site", Origin: `http://${host}` },
  ]) {
    const result = await status(headers);
    assert(result === 403, `${JSON.stringify(headers)}: expected 403, got ${result}`);
    assert(await stillSignedIn(), `${JSON.stringify(headers)}: the request must not have run`);
  }

  // Reads are never refused.
  const read = await jar.fetch(`${baseUrl}/api/auth/me`, { headers: { "Sec-Fetch-Site": "cross-site" } });
  assert(read.status === 200, `GET with cross-site: expected 200, got ${read.status}`);

  // Our own pages, typed URLs and non-browser callers pass.
  for (const headers of [{ "Sec-Fetch-Site": "same-origin" }, { Origin: `http://${host}` }, {}]) {
    const second = createCookieJar();
    assert((await login(second, baseUrl, "student_a2", "student123")).ok, "sign in again");
    const response = await second.fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", ...headers },
    });
    assert(response.status === 200, `${JSON.stringify(headers)}: expected 200, got ${response.status}`);
  }
  const third = createCookieJar();
  assert((await login(third, baseUrl, "student_a2", "student123")).ok, "sign in again");
  const none = await third.fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: { "Sec-Fetch-Site": "none" } });
  assert(none.status === 200, `Sec-Fetch-Site none: expected 200, got ${none.status}`);

  // A cross-site login is refused too (login CSRF).
  const forgedLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
    body: JSON.stringify({ username: "student_a2", password: "student123" }),
  });
  assert(forgedLogin.status === 403, `cross-site login: expected 403, got ${forgedLogin.status}`);
}
