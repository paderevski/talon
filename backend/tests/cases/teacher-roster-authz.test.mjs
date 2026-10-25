import { assert } from "../lib/harness.mjs";

export const name =
  "teacher roster requires teacher and returns class students";

export async function run({ baseUrl }) {
  const forbiddenResponse = await fetch(`${baseUrl}/api/teacher/students`, {
    headers: {
      "x-talon-user": "admin",
    },
  });

  assert(
    forbiddenResponse.status === 403,
    `Expected admin access to be rejected with 403, got ${forbiddenResponse.status}`,
  );

  const response = await fetch(`${baseUrl}/api/teacher/students`, {
    headers: {
      "x-talon-user": "talon_user",
    },
  });

  assert(response.ok, `Expected teacher roster 200, got ${response.status}`);

  const payload = await response.json();
  assert(payload?.ok === true, "Expected teacher roster payload ok=true");
  assert(
    payload?.roster?.teacher?.username === "talon_user",
    "Expected teacher roster to identify talon_user",
  );
  assert(
    payload?.roster?.teacher?.className === "ML Foundations",
    "Expected teacher roster to include class name",
  );
  assert(
    Array.isArray(payload?.roster?.students) &&
      payload.roster.students.length === 1,
    "Expected teacher roster to include one seeded student",
  );
}
