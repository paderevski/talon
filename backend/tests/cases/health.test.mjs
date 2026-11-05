import { assert } from "../lib/harness.mjs";

export const name = "health endpoints respond (full and liveness)";

export async function run({ baseUrl }) {
  const response = await fetch(`${baseUrl}/api/health`);
  assert(
    response.ok,
    `Expected health endpoint to return 200, got ${response.status}`,
  );

  const payload = await response.json();
  assert(payload?.ok === true, "Expected health payload to contain ok=true");
  assert(payload?.database === "ok", `Expected database=ok, got ${payload?.database}`);

  // The load balancer's check: app up, no database involved.
  const live = await fetch(`${baseUrl}/api/health/live`);
  assert(live.ok, `Expected liveness endpoint to return 200, got ${live.status}`);
  const livePayload = await live.json();
  assert(livePayload?.ok === true && livePayload?.database === undefined, `Expected ok=true and no database field, got ${JSON.stringify(livePayload)}`);
}
