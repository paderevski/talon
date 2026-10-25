import { assert } from "../lib/harness.mjs";

export const name = "admin roster requires admin and returns seeded roster";

export async function run({ baseUrl }) {
  const forbiddenResponse = await fetch(`${baseUrl}/api/admin/roster`, {
    headers: {
      "x-talon-user": "talon_user",
    },
  });

  assert(
    forbiddenResponse.status === 403,
    `Expected teacher access to be rejected with 403, got ${forbiddenResponse.status}`,
  );

  const response = await fetch(`${baseUrl}/api/admin/roster`, {
    headers: {
      "x-talon-user": "admin",
    },
  });

  assert(response.ok, `Expected admin roster 200, got ${response.status}`);

  const payload = await response.json();
  assert(payload?.ok === true, "Expected roster payload ok=true");
  assert(
    payload?.roster?.stats?.adminCount === 1,
    "Expected one admin in roster stats",
  );
  assert(
    payload?.roster?.stats?.teacherCount === 1,
    "Expected one teacher in roster stats",
  );
  assert(
    payload?.roster?.stats?.studentCount === 1,
    "Expected one student in roster stats",
  );
  assert(
    Array.isArray(payload?.roster?.teachers),
    "Expected teachers[] in roster payload",
  );
  assert(
    payload.roster.teachers.length === 1,
    "Expected one teacher record in roster payload",
  );
}
