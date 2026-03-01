import { assert } from "../lib/harness.mjs";

export const name = "github token status tolerates missing auth header";

export async function run({ baseUrl }) {
  const response = await fetch(`${baseUrl}/api/github-credentials`);
  assert(
    response.ok,
    `Expected /api/github-credentials to return 200 without header, got ${response.status}`,
  );

  const payload = await response.json();
  assert(
    payload?.hasToken === false,
    "Expected hasToken=false without auth header",
  );
  assert(
    typeof payload?.tokenLast4 === "string",
    "Expected tokenLast4 string field",
  );
}
