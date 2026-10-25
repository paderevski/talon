import { assert, createCookieJar, login } from "../lib/harness.mjs";

export const name = "github token status requires sign-in";

export async function run({ baseUrl }) {
  const anonymous = await fetch(`${baseUrl}/api/github-credentials`);
  assert(anonymous.status === 401, `Expected anonymous 401, got ${anonymous.status}`);

  const jar = createCookieJar();
  await login(jar, baseUrl, "jane_smith", "talon123");
  const response = await jar.fetch(`${baseUrl}/api/github-credentials`);
  assert(response.ok, `Expected signed-in status 200, got ${response.status}`);

  const payload = await response.json();
  assert(payload?.hasToken === false, "Expected hasToken=false for a user with no saved token");
  assert(typeof payload?.tokenLast4 === "string", "Expected tokenLast4 string field");
}
