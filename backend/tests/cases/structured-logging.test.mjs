import { assert, createCookieJar, login, startBackendForTests, waitFor } from "../lib/harness.mjs";

export const name = "structured logs: JSON lines with request ids, login events, no secrets";

function parseLines(output) {
  return output
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
}

export async function run() {
  const backend = await startBackendForTests({ reset: false, env: { TALON_LOG_FORMAT: "json" } });
  try {
    const { baseUrl } = backend;
    const wrongPassword = "not-the-password-logtest";

    const stranger = createCookieJar();
    const failed = await login(stranger, baseUrl, "logtest_nobody", wrongPassword);
    assert(failed.status === 401, `Expected 401 for a wrong password, got ${failed.status}`);

    const admin = createCookieJar();
    const ok = await login(admin, baseUrl, "admin", "admin123");
    assert(ok.ok, `admin login failed: ${ok.status}`);

    // A valid incoming request id (nginx's $request_id) is kept and echoed.
    const me = await admin.fetch(`${baseUrl}/api/auth/me?code=query-secret-logtest`, {
      headers: { "X-Request-Id": "abc123def456abc123def456" },
    });
    assert(me.ok, `/api/auth/me failed: ${me.status}`);
    assert(me.headers.get("x-request-id") === "abc123def456abc123def456", "incoming request id is echoed");

    // An invalid one is replaced.
    const bad = await fetch(`${baseUrl}/api/health`, { headers: { "X-Request-Id": "bad id with spaces" } });
    const generated = bad.headers.get("x-request-id") || "";
    assert(generated && generated !== "bad id with spaces", `invalid request id must be replaced, got ${generated}`);

    let lines = [];
    await waitFor(
      () => {
        lines = parseLines(backend.output());
        return lines.some((l) => l.event === "http.request" && l.requestId === "abc123def456abc123def456");
      },
      { timeoutMs: 5_000, label: "request log line" },
    );

    for (const line of lines) {
      assert(typeof line.time === "string" && typeof line.level === "string" && typeof line.msg === "string", `line shape: ${JSON.stringify(line)}`);
    }

    const meLine = lines.find((l) => l.event === "http.request" && l.requestId === "abc123def456abc123def456");
    assert(meLine.path === "/api/auth/me", `path logged without query: ${meLine.path}`);
    assert(meLine.status === 200 && meLine.method === "GET", `status/method: ${JSON.stringify(meLine)}`);
    assert(typeof meLine.durationMs === "number", "durationMs is a number");
    assert(meLine.userId !== undefined, "signed-in request logs the user id");

    const failedLine = lines.find((l) => l.event === "auth.login_failed");
    assert(failedLine?.username === "logtest_nobody" && failedLine.level === "warn", `login_failed event: ${JSON.stringify(failedLine)}`);
    assert(lines.some((l) => l.event === "auth.login" && l.username === "admin"), "successful login event");

    // Health checks are debug-level (not logged at the default level).
    assert(!lines.some((l) => l.event === "http.request" && l.path === "/api/health"), "health checks are not logged at info");

    const output = backend.output();
    assert(!output.includes(wrongPassword), "passwords are never logged");
    assert(!output.includes("admin123"), "passwords are never logged");
    assert(!output.includes("query-secret-logtest"), "query strings are never logged");
    assert(!/talon\.sid=/.test(output), "cookies are never logged");
  } finally {
    await backend.stop();
  }
}
