import { assert, createCookieJar, login } from "../lib/harness.mjs";

export const name = "removing the teacher role is refused while the pool has money";

export async function run({ baseUrl }) {
  const admin = createCookieJar();
  await login(admin, baseUrl, "admin", "admin123");
  const send = (method, path, body) =>
    admin.fetch(`${baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  // A teacher with no classes, so only the pool can stand in the way.
  const username = `pool_guard_${Date.now()}`;
  const created = await send("POST", "/api/admin/users", { username, fullName: "Pool Guard", roles: ["teacher", "student"] });
  assert(created.status === 201, `Expected create 201, got ${created.status}`);
  const { id } = await created.json();
  assert(id, "Expected the new user's id");

  const fund = await send("POST", "/api/admin/budget/adjustments", { userId: id, target: "pool", direction: "increase", amount: 2 });
  assert(fund.status === 201, `Expected pool funding 201, got ${fund.status}`);

  const refused = await send("PATCH", `/api/admin/users/${id}`, { roles: ["student"] });
  assert(refused.status === 409, `Expected 409 while the pool has money, got ${refused.status}`);
  const message = (await refused.json()).message || "";
  assert(message.includes("$2.00"), `Expected the pool amount in the message, got: ${message}`);

  const back = await send("POST", "/api/admin/budget/adjustments", { userId: id, target: "pool", direction: "decrease", amount: 2 });
  assert(back.status === 201, `Expected take back 201, got ${back.status}`);

  const allowed = await send("PATCH", `/api/admin/users/${id}`, { roles: ["student"] });
  assert(allowed.ok, `Expected the role change once the pool is empty, got ${allowed.status}`);
}
