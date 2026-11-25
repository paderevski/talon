import { assert, createCookieJar, login, withTestDb } from "../lib/harness.mjs";

// Runs late (zz-): it changes balances other tests read.
export const name = "School account: admin funds and corrects it, funds others from it; summary; teacher moves own budget";

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

const cents = (sql, params = []) =>
  withTestDb((pool) => pool.query(sql, params)).then((result) => Number(result.rows[0]?.c ?? 0));
const schoolCents = () => cents("SELECT balance_cents AS c FROM budget_accounts WHERE kind = 'school'");
const accountCents = (username, kind) =>
  cents(
    "SELECT a.balance_cents AS c FROM budget_accounts a JOIN users u ON u.id = a.owner_user_id WHERE u.username = $1 AND a.kind = $2",
    [username, kind],
  );

export async function run({ baseUrl }) {
  const admin = createCookieJar();
  await login(admin, baseUrl, "admin", "admin123");
  const adjust = (body) => send(admin, baseUrl, "POST", "/api/admin/budget/adjustments", body);
  const adminId = await withTestDb((pool) => pool.query("SELECT id FROM users WHERE username = 'admin'")).then((r) => r.rows[0].id);

  // School: grant in, correct out (never below zero).
  const start = await schoolCents();
  assert((await adjust({ target: "school", direction: "increase", amount: 1000, note: "2026-27 budget" })).status === 201, "fund School");
  assert((await schoolCents()) === start + 100_000, "School up $1,000");
  assert((await adjust({ target: "school", direction: "decrease", amount: 250 })).status === 201, "correct School");
  assert((await schoolCents()) === start + 75_000, "School down $250");
  const tooMuch = await adjust({ target: "school", direction: "decrease", amount: 99_999 });
  assert(tooMuch.status === 409 && /School account has only/.test(tooMuch.payload.message), `School overdraw: ${tooMuch.status} ${tooMuch.payload.message}`);

  // Admin's own budget comes from School and goes back to it.
  const adminBefore = await accountCents("admin", "personal");
  const schoolBefore = await schoolCents();
  assert((await adjust({ userId: adminId, target: "personal", direction: "increase", amount: 20 })).status === 201, "admin self-funds");
  assert((await accountCents("admin", "personal")) === adminBefore + 2000 && (await schoolCents()) === schoolBefore - 2000, "moved School -> admin");
  assert((await adjust({ userId: adminId, target: "personal", direction: "decrease", amount: 20 })).status === 201, "admin returns");
  assert((await schoolCents()) === schoolBefore, "back in School");

  // Not enough in School: a pool cannot be funded past it.
  const teacherId = await withTestDb((pool) => pool.query("SELECT id FROM users WHERE username = 'teacher_ada'")).then((r) => r.rows[0].id);
  const overFund = await adjust({ userId: teacherId, target: "pool", direction: "increase", amount: (await schoolCents()) / 100 + 1 });
  assert(overFund.status === 409 && /School account has only/.test(overFund.payload.message), `pool past School: ${overFund.status}`);

  // Summary: the period's budget is what came into School; balances now.
  const summary = await send(admin, baseUrl, "GET", "/api/admin/budget/summary");
  assert(summary.status === 200, `summary ${summary.status}`);
  const s = summary.payload.summary;
  assert(/^\d{4}-07-01$/.test(s.from) && /^\d{4}-06-30$/.test(s.to), `default school year ${s.from}..${s.to}`);
  assert(s.school === (await schoolCents()) / 100, `summary School ${s.school}`);
  assert(s.budget >= 750, `budget in the period includes the $750 net added: ${s.budget}`);
  assert(typeof s.spent === "number" && typeof s.teacherPools === "number", "spent and pools are numbers");
  const empty = await send(admin, baseUrl, "GET", "/api/admin/budget/summary?from=2001-07-01&to=2002-06-30");
  assert(empty.status === 200 && empty.payload.summary.budget === 0 && empty.payload.summary.spent === 0, "an old year is empty");
  assert((await send(admin, baseUrl, "GET", "/api/admin/budget/summary?from=nope")).status === 400, "bad date 400");
  assert((await send(admin, baseUrl, "GET", "/api/admin/budget/summary?from=2026-07-01&to=2026-01-01")).status === 400, "reversed 400");

  const teacher = createCookieJar();
  await login(teacher, baseUrl, "teacher_ada", "teach123");
  assert((await send(teacher, baseUrl, "GET", "/api/admin/budget/summary")).status === 403, "summary is admin only");

  // Teacher: pool -> own budget and back, never past either balance.
  const own = (body) => send(teacher, baseUrl, "POST", "/api/teacher/own-budget", body);
  const poolBefore = await accountCents("teacher_ada", "teacher_pool");
  const mineBefore = await accountCents("teacher_ada", "personal");
  assert((await own({ amount: 1, direction: "to-me" })).status === 201, "teacher takes $1");
  assert((await accountCents("teacher_ada", "teacher_pool")) === poolBefore - 100, "pool down $1");
  assert((await accountCents("teacher_ada", "personal")) === mineBefore + 100, "own budget up $1");
  const overOwn = await own({ amount: 99_999, direction: "to-pool" });
  assert(overOwn.status === 409 && /Your own budget has only/.test(overOwn.payload.message), `own overdraw: ${overOwn.payload.message}`);
  assert((await own({ amount: 1, direction: "to-pool" })).status === 201, "teacher returns $1");
  assert((await accountCents("teacher_ada", "teacher_pool")) === poolBefore, "pool back");
  assert((await own({ amount: 1, direction: "sideways" })).status === 400, "bad direction 400");

  const student = createCookieJar();
  await login(student, baseUrl, "student_a1", "student123");
  assert((await send(student, baseUrl, "POST", "/api/teacher/own-budget", { amount: 1 })).status === 403, "students cannot");
  assert((await send(student, baseUrl, "POST", "/api/admin/budget/adjustments", { target: "school", direction: "increase", amount: 1 })).status === 403, "students cannot fund School");
}
