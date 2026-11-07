import assert from "node:assert/strict";
import test from "node:test";
import {
  cancelJob,
  disconnectConnection,
  fetchConnections,
  fetchCurrentUser,
  fetchJobs,
  GatewayError,
  getJobFileDownloadUrl,
  hideJob,
  login,
  setUnauthorizedHandler,
  unhideJob,
} from "../src/api/client.js";

// fetch answers every request with this status and body (text).
function answer(status, body) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(body, { status, headers: { "Content-Type": body.startsWith("{") ? "application/json" : "text/html" } });
  };
  return calls;
}

const writes = [
  ["cancelJob", () => cancelJob("job-1")],
  ["hideJob", () => hideJob("job-1", "done")],
  ["unhideJob", () => unhideJob("job-1")],
  ["disconnectConnection", () => disconnectConnection("github", "GitHub")],
];

test("a 502 or 504 on a write is a GatewayError: the change may have been made", async () => {
  for (const status of [502, 504]) {
    for (const [name, write] of writes) {
      answer(status, "<html>Bad Gateway</html>");
      await assert.rejects(write(), (error) => error instanceof GatewayError && /may still have been made/.test(error.message), `${name} ${status}`);
    }
  }
});

test("other write failures carry the server's message, or the status", async () => {
  for (const [name, write] of writes) {
    answer(409, JSON.stringify({ message: "Job has already finished" }));
    await assert.rejects(write(), (error) => !(error instanceof GatewayError) && error.message === "Job has already finished", name);
    answer(500, "oops");
    await assert.rejects(write(), (error) => !(error instanceof GatewayError) && /\(500\)$/.test(error.message), name);
  }
});

test("writes send the session cookie; a 401 outside /api/auth signs the user out", async () => {
  let signedOut = 0;
  setUnauthorizedHandler(() => { signedOut += 1; });
  const calls = answer(401, JSON.stringify({ message: "Not signed in" }));
  await assert.rejects(cancelJob("job-1"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.equal(signedOut, 1);
  setUnauthorizedHandler(null);
});

test("a 401 from /api/auth (bad login, session check) does not trigger sign-out", async () => {
  let signedOut = 0;
  setUnauthorizedHandler(() => { signedOut += 1; });
  answer(401, JSON.stringify({ message: "Invalid username or password" }));
  await assert.rejects(login("a", "b"), /Invalid username or password/);
  answer(401, JSON.stringify({ message: "Not signed in" }));
  assert.equal(await fetchCurrentUser(), null);
  assert.equal(signedOut, 0);
  setUnauthorizedHandler(null);
});

test("job list and download URLs are built with encoding; owner is only passed to the server", async () => {
  const calls = answer(200, JSON.stringify({ items: [] }));
  await fetchJobs("hidden", { owner: "a b&c" });
  const url = new URL(calls[0].url, "http://x");
  assert.equal(url.pathname, "/api/jobs");
  assert.deepEqual(Object.fromEntries(url.searchParams), { status: "hidden", owner: "a b&c", includeHidden: "1" });
  await fetchJobs("running");
  assert.equal(new URL(calls[1].url, "http://x").searchParams.has("includeHidden"), false);

  const download = new URL(getJobFileDownloadUrl("job/1", "a&b#c.txt", "repo_changed"), "http://x");
  assert.equal(download.pathname, "/api/jobs/job%2F1/files/download");
  assert.equal(download.searchParams.get("name"), "a&b#c.txt");
  assert.equal(download.searchParams.get("source"), "repo_changed");
});

test("fetchConnections tolerates a body without a list", async () => {
  answer(200, JSON.stringify({ items: null }));
  assert.deepEqual(await fetchConnections(), []);
});
