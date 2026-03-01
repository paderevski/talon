import { assert } from "../lib/harness.mjs";

export const name = "health endpoint responds";

export async function run({ baseUrl }) {
  const response = await fetch(`${baseUrl}/api/health`);
  assert(
    response.ok,
    `Expected health endpoint to return 200, got ${response.status}`,
  );

  const payload = await response.json();
  assert(payload?.ok === true, "Expected health payload to contain ok=true");
}
