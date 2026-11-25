import { assert, createCookieJar, login, startBackendForTests, withTestDb } from "../lib/harness.mjs";

export const name = "when jobs cost money, a user with no budget cannot submit (admins too), with a role-specific hint";

const balanceOf = (username) =>
  withTestDb(async (pool) => Number((await pool.query(
    `SELECT a.balance_cents FROM budget_accounts a JOIN users u ON u.id = a.owner_user_id
     WHERE u.username = $1 AND a.kind = 'personal'`,
    [username],
  )).rows[0].balance_cents));

const setBalance = (username, cents) =>
  withTestDb((pool) =>
    pool.query(
      `UPDATE budget_accounts SET balance_cents = $2
       WHERE kind = 'personal' AND owner_user_id = (SELECT id FROM users WHERE username = $1)`,
      [username, cents],
    ));

export async function run() {
  // A separate server with a non-zero job rate (the default rate is 0: free).
  const server = await startBackendForTests({
    env: { JOB_RATE_CENTS_PER_HOUR: "600" },
    reset: false,
  });

  // Balances are set directly (not through the ledger), so they are put back
  // whatever happens: later tests check balances against the ledger.
  const cases = [
    { username: "student_g5", password: "student123", hint: /ask your teacher/i },
    { username: "admin", password: "admin123", hint: /School account/ },
  ];
  const before = new Map();
  for (const { username } of cases) {
    before.set(username, await balanceOf(username));
  }

  try {
    for (const { username, password, hint } of cases) {
      const jar = createCookieJar();
      await login(jar, server.baseUrl, username, password);
      await setBalance(username, 0);
      const response = await jar.fetch(`${server.baseUrl}/api/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "should-be-blocked", repo: "octocat/Hello-World" }),
      });
      const payload = await response.json();
      assert(response.status === 402, `Expected 402 for ${username} with $0, got ${response.status}`);
      assert(hint.test(payload.message), `${username}: hint in ${payload.message}`);
    }

    const created = await withTestDb(async (pool) =>
      (await pool.query("SELECT count(*)::int AS n FROM jobs WHERE name = 'should-be-blocked'")).rows[0].n);
    assert(created === 0, "A blocked submit must not create a job");
  } finally {
    for (const [username, cents] of before) {
      await setBalance(username, cents);
    }
    await server.stop();
  }
}
