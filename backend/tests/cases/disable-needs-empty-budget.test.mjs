import { assert, createCookieJar, login } from "../lib/harness.mjs";

export const name = "disabling is refused while the user's own budget or pool has money";

export async function run({ baseUrl }) {
  const admin = createCookieJar();
  await login(admin, baseUrl, "admin", "admin123");
  const send = (method, path, body) =>
    admin.fetch(`${baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const adjust = (body) => send("POST", "/api/admin/budget/adjustments", body);

  const created = await send("POST", "/api/admin/users", { username: `disable_guard_${Date.now()}`, fullName: "Disable Guard", roles: ["teacher"] });
  assert(created.status === 201, `Expected create 201, got ${created.status}`);
  const { id } = await created.json();

  assert((await adjust({ userId: id, target: "personal", direction: "increase", amount: 1 })).status === 201, "fund own budget");
  assert((await adjust({ userId: id, target: "pool", direction: "increase", amount: 2 })).status === 201, "fund pool");

  const refused = await send("PATCH", `/api/admin/users/${id}`, { status: "disabled" });
  assert(refused.status === 409, `Expected 409 while money is left, got ${refused.status}`);
  const message = (await refused.json()).message || "";
  assert(message.includes("$1.00") && message.includes("$2.00"), `Expected both amounts in the message, got: ${message}`);

  assert((await adjust({ userId: id, target: "personal", direction: "decrease", amount: 1 })).status === 201, "take back own budget");
  const stillPool = await send("PATCH", `/api/admin/users/${id}`, { status: "disabled" });
  assert(stillPool.status === 409, `Expected 409 while the pool has money, got ${stillPool.status}`);

  assert((await adjust({ userId: id, target: "pool", direction: "decrease", amount: 2 })).status === 201, "take back pool");
  const allowed = await send("PATCH", `/api/admin/users/${id}`, { status: "disabled" });
  assert(allowed.ok, `Expected disable once both are empty, got ${allowed.status}`);
}
