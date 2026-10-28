import { assert, createCookieJar, login, startBackendForTests, withTestDb } from "../lib/harness.mjs";

export const name = "EC2 jobs: access rules, input validation, kill switch, and no local runs for students in production";

const post = (jar, baseUrl, body) =>
  jar.fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const options = async (jar, baseUrl) => (await jar.fetch(`${baseUrl}/api/jobs/compute-options`)).json();

async function jobCount(names) {
  return withTestDb(async (pool) =>
    (await pool.query("SELECT count(*)::int AS n FROM jobs WHERE name = ANY($1)", [names])).rows[0].n);
}

export async function run({ baseUrl }) {
  // 1. EC2 off (the default): nobody gets it, nothing is created.
  const student = createCookieJar();
  await login(student, baseUrl, "student_a1", "student123");
  const admin = createCookieJar();
  await login(admin, baseUrl, "admin", "admin123");
  assert((await post(student, baseUrl, { name: "off-s", repo: "o/r", compute: "ec2" })).status === 503, "EC2 off: student gets 503");
  assert((await post(admin, baseUrl, { name: "off-a", repo: "o/r", compute: "ec2" })).status === 503, "EC2 off: admin gets 503");
  const off = await options(student, baseUrl);
  assert(off.ec2.enabled === false && off.ec2.options.length === 0 && off.localAllowed === true, `EC2 off options ${JSON.stringify(off)}`);

  // 2. EC2 on: students are offered machines; bad input is refused before anything is created.
  const on = await startBackendForTests({ env: { EC2_JOBS_ENABLED: "true", EC2_RECONCILE_INTERVAL_MS: "3600000" }, reset: false });
  try {
    const s = createCookieJar();
    await login(s, on.baseUrl, "student_a1", "student123");
    const menu = await options(s, on.baseUrl);
    assert(menu.ec2.enabled && menu.ec2.options.length >= 3, `menu ${JSON.stringify(menu).slice(0, 300)}`);
    const m7g = menu.ec2.options.find((o) => o.instanceType === "m7g.large");
    assert(m7g && m7g.memoryGb === 8 && m7g.vcpus === 2 && m7g.reserveCentsByRuntime["3600"] > 0, `m7g.large ${JSON.stringify(m7g)}`);
    assert(menu.ec2.runtimeSeconds.includes(3600) && menu.ec2.runtimeSeconds.at(-1) === 86400 && menu.ec2.maxJobsPerUser === 1, `limits ${JSON.stringify(menu.ec2)}`);
    assert(!menu.ec2.options.some((o) => o.instanceType.startsWith("t4g")), "burstable types must not be offered");

    for (const [label, body] of [
      ["unknown instance type", { instanceType: "p5.48xlarge" }],
      ["time limit not offered", { maxRuntimeSeconds: 99999 }],
      ["bad environment variable", { environmentVariables: "PATH=/tmp" }],
    ]) {
      const response = await post(s, on.baseUrl, { name: `bad-${label}`, repo: "o/r", entryScript: "t.py", compute: "ec2", ...body });
      assert(response.status === 400, `${label}: expected 400, got ${response.status}`);
    }
    assert((await jobCount(["bad-unknown instance type", "bad-time limit not offered", "bad-bad environment variable"])) === 0, "refused requests must not create jobs");
  } finally {
    await on.stop();
  }

  // 3. Kill switch: admin-only.
  const restricted = await startBackendForTests({ env: { EC2_JOBS_ENABLED: "true", EC2_JOBS_ADMIN_ONLY: "true", EC2_RECONCILE_INTERVAL_MS: "3600000" }, reset: false });
  try {
    const s = createCookieJar();
    await login(s, restricted.baseUrl, "student_a1", "student123");
    const a = createCookieJar();
    await login(a, restricted.baseUrl, "admin", "admin123");
    assert((await options(s, restricted.baseUrl)).ec2.enabled === false, "kill switch hides EC2 from students");
    assert((await options(a, restricted.baseUrl)).ec2.enabled === true, "kill switch keeps EC2 for admins");
    assert((await post(s, restricted.baseUrl, { name: "ks", repo: "o/r", compute: "ec2" })).status === 403, "kill switch: student gets 403");
  } finally {
    await restricted.stop();
  }

  // 4. Production: students cannot run on the web server itself.
  const production = await startBackendForTests({
    env: { NODE_ENV: "production", SESSION_SECRET: "t".repeat(64), TALON_CREDENTIALS_KEY: "k".repeat(32), EC2_JOBS_ENABLED: "true", EC2_RECONCILE_INTERVAL_MS: "3600000" },
    reset: false,
  });
  try {
    const s = createCookieJar();
    await login(s, production.baseUrl, "student_a1", "student123");
    assert((await options(s, production.baseUrl)).localAllowed === false, "students are not offered local runs in production");
    const response = await post(s, production.baseUrl, { name: "prod-local", repo: "octocat/Hello-World" });
    assert(response.status === 403, `local run for a student in production: expected 403, got ${response.status}`);
    assert((await jobCount(["prod-local"])) === 0, "refused local run must not create a job");
  } finally {
    await production.stop();
  }
}
