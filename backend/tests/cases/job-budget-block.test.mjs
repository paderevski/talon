import { assert, createCookieJar, login, startBackendForTests, withTestDb } from "../lib/harness.mjs";

export const name = "when jobs cost money, a user with no budget (or an overdrawn one) cannot submit";

const setBalance = (cents) =>
  withTestDb((pool) =>
    pool.query(
      `UPDATE budget_accounts SET balance_cents = $1
       WHERE kind = 'personal' AND owner_user_id = (SELECT id FROM users WHERE username = 'student_g5')`,
      [cents],
    ));

export async function run() {
  // A separate server with a non-zero job rate (the default rate is 0: free).
  const server = await startBackendForTests({
    env: { JOB_RATE_CENTS_PER_HOUR: "600" },
    reset: false,
  });

  // The balance is set directly (not through the ledger), so it is put back
  // whatever happens: later tests check balances against the ledger.
  const before = await withTestDb(async (pool) => Number((await pool.query(
    `SELECT a.balance_cents FROM budget_accounts a JOIN users u ON u.id = a.owner_user_id
     WHERE u.username = 'student_g5' AND a.kind = 'personal'`,
  )).rows[0].balance_cents));

  try {
    const jar = createCookieJar();
    await login(jar, server.baseUrl, "student_g5", "student123");
    for (const cents of [0, -1]) {
      await setBalance(cents);
      const response = await jar.fetch(`${server.baseUrl}/api/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "should-be-blocked", repo: "octocat/Hello-World" }),
      });
      assert(response.status === 402, `Expected 402 with a balance of ${cents}c, got ${response.status}`);
    }

    const created = await withTestDb(async (pool) =>
      (await pool.query("SELECT count(*)::int AS n FROM jobs WHERE name = 'should-be-blocked'")).rows[0].n);
    assert(created === 0, "A blocked submit must not create a job");
  } finally {
    await setBalance(before);
    await server.stop();
  }
}
