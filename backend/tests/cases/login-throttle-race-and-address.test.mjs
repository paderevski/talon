import { assert, createCookieJar, login, withTestDb } from "../lib/harness.mjs";

export const name = "login throttling: parallel guesses are capped, locks are per address, change-password is throttled";

const json = { "Content-Type": "application/json" };

// The test server trusts loopback proxies, so X-Forwarded-For sets req.ip.
function attempt(baseUrl, username, password, ip) {
  return fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { ...json, ...(ip ? { "X-Forwarded-For": ip } : {}) },
    body: JSON.stringify({ username, password }),
  });
}

async function createUser(admin, baseUrl, username) {
  const created = await (await admin.fetch(`${baseUrl}/api/admin/users`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ username, roles: ["student"] }),
  })).json();
  assert(created.id && created.password, `create ${username}`);
  return created;
}

const counts = (responses) => {
  const tally = {};
  for (const response of responses) tally[response.status] = (tally[response.status] ?? 0) + 1;
  return tally;
};

export async function run({ baseUrl }) {
  const admin = createCookieJar();
  await login(admin, baseUrl, "admin", "admin123");
  const racer = await createUser(admin, baseUrl, "race_user");
  const walker = await createUser(admin, baseUrl, "walk_user");
  const changer = await createUser(admin, baseUrl, "change_user");
  const names = ["race_user", "walk_user", "change_user", "spread_user"];

  try {
    // 40 parallel wrong guesses from one address: a 401 means the password
    // was actually checked, so exactly the cap (5) gets that far.
    const burst = await Promise.all(
      Array.from({ length: 40 }, () => attempt(baseUrl, "race_user", "wrong-password", "203.0.113.10")),
    );
    const tally = counts(burst);
    assert(tally[401] === 5 && tally[429] === 35, `parallel burst: expected 5x401 + 35x429, got ${JSON.stringify(tally)}`);
    // The refused ones did not eat into the account's shared allowance.
    const shared = await withTestDb(async (pool) =>
      (await pool.query("SELECT attempts FROM login_throttle WHERE scope = 'login_user' AND username_key = 'race_user'")).rows[0]);
    assert(shared.attempts === 5, `shared count after the burst: ${shared.attempts}`);

    // That address is locked, even with the right password...
    assert((await attempt(baseUrl, "race_user", racer.password, "203.0.113.10")).status === 429, "locked address, right password");
    // ...but the real user, from another address, signs in.
    const real = await attempt(baseUrl, "race_user", racer.password, "198.51.100.7");
    assert(real.status === 200, `other address should still sign in, got ${real.status}`);

    // Hammering from the locked address does not lock the user out elsewhere.
    for (let i = 0; i < 30; i += 1) await attempt(baseUrl, "walk_user", "wrong-password", "203.0.113.20");
    assert((await attempt(baseUrl, "walk_user", walker.password, "198.51.100.8")).status === 200, "attacker address must not lock the account for others");

    // A guess spread over many addresses is still bounded: 20 across all.
    const spread = [];
    for (let i = 0; i < 25; i += 1) {
      spread.push((await attempt(baseUrl, "spread_user", "wrong-password", `192.0.2.${i + 1}`)).status);
    }
    assert(spread.filter((s) => s === 401).length === 20 && spread.slice(20).every((s) => s === 429),
      `spread guesses: ${spread.join(",")}`);

    // Admin unlock clears every lock for the name.
    const unlock = await admin.fetch(`${baseUrl}/api/admin/users/${racer.id}/unlock`, { method: "POST" });
    assert(unlock.ok, `unlock ${unlock.status}`);
    assert((await attempt(baseUrl, "race_user", racer.password, "203.0.113.10")).status === 200, "signs in after unlock from the locked address");

    // Change-password: wrong current passwords are capped per user.
    const user = createCookieJar();
    assert((await login(user, baseUrl, "change_user", changer.password)).ok, "sign in");
    const change = (currentPassword, newPassword = "a-new-password-1") =>
      user.fetch(`${baseUrl}/api/auth/password`, { method: "POST", headers: json, body: JSON.stringify({ currentPassword, newPassword }) });
    const tries = await Promise.all(Array.from({ length: 12 }, () => change("not-the-password")));
    const triesTally = counts(tries);
    assert(triesTally[403] === 5 && triesTally[429] === 7, `change-password burst: ${JSON.stringify(triesTally)}`);
    const refused = await change(changer.password);
    assert(refused.status === 429 && Number(refused.headers.get("retry-after")) > 0, `right password while throttled: ${refused.status}`);
    await withTestDb((pool) => pool.query("UPDATE login_throttle SET window_started_at = now() - interval '1 hour' WHERE scope = 'password'"));
    const changed = await change(changer.password);
    assert(changed.status === 200, `change after the window: ${changed.status}`);
  } finally {
    await withTestDb((pool) => pool.query("DELETE FROM login_throttle WHERE username_key = ANY($1)", [names]));
  }
}
