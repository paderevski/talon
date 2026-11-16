import { assert } from "../lib/harness.mjs";

export const name = "API responses: no X-Powered-By, no-store, nosniff";

export async function run({ baseUrl }) {
  // One public and one rejected (401) response: the headers are set before routing.
  for (const path of ["/api/health", "/api/jobs"]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert(response.headers.get("x-powered-by") === null, `${path}: X-Powered-By must not be sent`);
    assert(response.headers.get("cache-control") === "no-store", `${path}: expected Cache-Control no-store, got ${response.headers.get("cache-control")}`);
    assert(response.headers.get("x-content-type-options") === "nosniff", `${path}: expected X-Content-Type-Options nosniff`);
  }
}
