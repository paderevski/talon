import { assert } from "../lib/harness.mjs";

export const name = "auth login uses sqlite seeded users";

export async function run({ baseUrl }) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username: "jane_smith",
      password: "talon123",
    }),
  });

  assert(
    response.ok,
    `Expected /api/auth/login to return 200, got ${response.status}`,
  );

  const payload = await response.json();
  assert(payload?.ok === true, "Expected login payload ok=true");
  assert(
    payload?.user?.username === "jane_smith",
    "Expected sqlite-backed login to return jane_smith",
  );
  assert(
    payload?.user?.role === "student",
    "Expected sqlite-backed login to return student role",
  );
  assert(
    payload?.user?.fullName === "Jane Smith",
    "Expected sqlite-backed login to return full name",
  );
}
