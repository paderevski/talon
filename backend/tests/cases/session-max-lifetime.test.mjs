import { setTimeout as sleep } from "node:timers/promises";
import { assert, createCookieJar, login, startBackendForTests } from "../lib/harness.mjs";

export const name = "sessions end SESSION_MAX_HOURS after sign-in, however active";

async function meStatus(jar, baseUrl) {
  return (await jar.fetch(`${baseUrl}/api/auth/me`)).status;
}

export async function run() {
  // 0.0008 hours is just under 3 seconds.
  const server = await startBackendForTests({ reset: false, env: { SESSION_MAX_HOURS: "0.0008" } });
  try {
    const jar = createCookieJar();
    await login(jar, server.baseUrl, "jane_smith", "talon123");
    const signedIn = Date.now();

    // Activity (rolling cookie) keeps it alive only until the limit.
    while (Date.now() - signedIn < 2000) {
      assert((await meStatus(jar, server.baseUrl)) === 200, "session works before the limit");
      await sleep(400);
    }
    await sleep(1500);
    assert((await meStatus(jar, server.baseUrl)) === 401, "session ended after the limit despite activity");

    // Signing in again starts a new clock.
    await login(jar, server.baseUrl, "jane_smith", "talon123");
    assert((await meStatus(jar, server.baseUrl)) === 200, "a new sign-in works");
  } finally {
    await server.stop();
  }
}
