import { assert, createCookieJar, login, withTestDb } from "../lib/harness.mjs";

// Runs late (name sorts after the others) because it adds users and classes.
export const name = "admin assigns students not in a class: several at once, optional starting budget, no double grant";

const json = { "Content-Type": "application/json" };

async function send(jar, baseUrl, method, path, body) {
  const response = await jar.fetch(`${baseUrl}${path}`, {
    method,
    headers: json,
    body: body === undefined || method === "GET" ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

export async function run({ baseUrl }) {
  const admin = createCookieJar();
  await login(admin, baseUrl, "admin", "admin123");

  const make = async (username, roles) => {
    const created = await send(admin, baseUrl, "POST", "/api/admin/users", { username, fullName: username, roles });
    assert(created.status === 201, `create ${username}: ${created.status} ${JSON.stringify(created.payload)}`);
    return created.payload;
  };
  const teacher = await make("assign_teacher", ["teacher"]);
  const one = await make("assign_one", ["student"]);
  const two = await make("assign_two", ["student"]);
  const staff = await make("assign_staff", ["teacher"]);
  const off = await make("assign_off", ["student"]);
  await send(admin, baseUrl, "PATCH", `/api/admin/users/${off.id}`, { status: "disabled" });

  const klass = await send(admin, baseUrl, "POST", "/api/admin/classes", { name: "Assign 101", block: "3", term: "2026-27", teacherId: teacher.id });
  assert(klass.status === 201, `create class: ${klass.status}`);
  const classId = klass.payload.id;

  // The users list says how each user signs in, when they were made, and
  // the session says whether a student is in a class yet.
  const listed = (await send(admin, baseUrl, "GET", "/api/admin/users")).payload.users;
  const oneListed = listed.find((user) => user.id === one.id);
  assert(JSON.stringify(oneListed.signIn) === JSON.stringify(["local"]) && oneListed.createdAt, `signIn/createdAt ${JSON.stringify(oneListed)}`);
  const oneJar = createCookieJar();
  await login(oneJar, baseUrl, "assign_one", one.password);
  const before = (await send(oneJar, baseUrl, "GET", "/api/auth/me")).payload.user;
  assert(before.inClass === false, `inClass before: ${JSON.stringify(before)}`);

  // Refused, and nothing written: not students, disabled, bad ids, archived.
  const path = `/api/admin/classes/${classId}/students`;
  const refusals = [
    [{ userIds: [] }, 400, /at least one/],
    [{ userIds: ["nope"] }, 400, /from the list/],
    [{ userIds: [one.id, staff.id] }, 400, /Not students: assign_staff/],
    [{ userIds: [one.id, off.id] }, 400, /Turned off/],
    [{ userIds: [one.id, "00000000-0000-0000-0000-000000000000"] }, 404, /no longer exists/],
    [{ userIds: [one.id], budget: -5 }, 400, /Amount/],
  ];
  for (const [body, status, pattern] of refusals) {
    const refused = await send(admin, baseUrl, "POST", path, body);
    assert(refused.status === status && pattern.test(refused.payload.message), `${JSON.stringify(body)}: ${refused.status} ${refused.payload.message}`);
  }
  const missing = await send(admin, baseUrl, "POST", "/api/admin/classes/999999/students", { userIds: [one.id] });
  assert(missing.status === 404, `missing class: ${missing.status}`);
  const untouched = await withTestDb((pool) => pool.query("SELECT count(*)::int AS n FROM class_members WHERE class_id = $1", [classId]));
  assert(untouched.rows[0].n === 0, "refused requests add nobody");

  // Students cannot call it.
  const denied = await send(oneJar, baseUrl, "POST", path, { userIds: [one.id] });
  assert(denied.status === 403, `student 403, got ${denied.status}`);

  // Two at once with $12.50 each (ids in any case).
  const assigned = await send(admin, baseUrl, "POST", path, { userIds: [one.id.toUpperCase(), two.id], budget: "12.50" });
  assert(assigned.status === 201 && assigned.payload.added === 2 && assigned.payload.grantedDollars === 12.5, `assign: ${JSON.stringify(assigned.payload)}`);
  const after = (await send(oneJar, baseUrl, "GET", "/api/auth/me")).payload.user;
  assert(after.inClass === true, "inClass after assignment");

  // Again (a double click): already members, no second grant.
  const again = await send(admin, baseUrl, "POST", path, { userIds: [one.id, two.id], budget: 12.5 });
  assert(again.status === 201 && again.payload.added === 0 && again.payload.alreadyMembers === 2, `again: ${JSON.stringify(again.payload)}`);
  const users = (await send(admin, baseUrl, "GET", "/api/admin/users")).payload.users;
  for (const id of [one.id, two.id]) {
    const user = users.find((candidate) => candidate.id === id);
    assert(user.personalBalance === 12.5, `${user.username} balance ${user.personalBalance}`);
    assert(user.classes.some((c) => c.id === classId && c.memberRole === "student"), `${user.username} in class`);
  }
  const grants = await withTestDb((pool) => pool.query(
    `SELECT l.note FROM budget_ledger l JOIN budget_accounts a ON a.id = l.account_id
     WHERE a.owner_user_id = $1 AND l.kind = 'grant'`,
    [one.id],
  ));
  assert(grants.rows.length === 1 && /Starting budget \(Assign 101/.test(grants.rows[0].note), `grant rows ${JSON.stringify(grants.rows)}`);

  // No budget: just added. Archived class: refused.
  const three = await make("assign_three", ["student"]);
  const plain = await send(admin, baseUrl, "POST", path, { userIds: [three.id], budget: "" });
  assert(plain.status === 201 && plain.payload.added === 1 && plain.payload.grantedDollars === 0, `no budget: ${JSON.stringify(plain.payload)}`);
  await send(admin, baseUrl, "PATCH", `/api/admin/classes/${classId}`, { archived: true });
  const four = await make("assign_four", ["student"]);
  const archived = await send(admin, baseUrl, "POST", path, { userIds: [four.id] });
  assert(archived.status === 409, `archived class: ${archived.status}`);
}
