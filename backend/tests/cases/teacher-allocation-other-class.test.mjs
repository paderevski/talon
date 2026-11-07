import { assert, createCookieJar, login, withTestDb } from "../lib/harness.mjs";

export const name = "teacher allocations: a student in another teacher's class is refused both ways";

const balances = () =>
  withTestDb(async (pool) => {
    const { rows } = await pool.query(
      `SELECT u.username, a.kind, a.balance_cents::int AS cents
         FROM budget_accounts a JOIN users u ON u.id = a.owner_user_id
        WHERE u.username IN ('teacher_ada', 'student_g1')`,
    );
    return JSON.stringify(rows.sort((x, y) => `${x.username}${x.kind}`.localeCompare(`${y.username}${y.kind}`)));
  });

export async function run({ baseUrl }) {
  const before = await balances();
  const ada = createCookieJar();
  await login(ada, baseUrl, "teacher_ada", "teach123");

  // student_g1 is in Grace's class, not Ada's.
  for (const direction of ["give", "take"]) {
    const response = await ada.fetch(`${baseUrl}/api/teacher/allocations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studentUsername: "student_g1", amount: 1, direction }),
    });
    assert(response.status === 404, `${direction} to another teacher's student: expected 404, got ${response.status}`);
  }

  assert((await balances()) === before, "no balance may change");
}
