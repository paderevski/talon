import { assert, createCookieJar, login } from "../lib/harness.mjs";

// Sorts after the other tests: it adds users and classes (see zz-management).
export const name = "CSV roster import previews, rejects bad rows, then creates users, classes and budgets";

async function post(jar, baseUrl, body) {
  const response = await jar.fetch(`${baseUrl}/api/admin/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json().catch(() => ({})) };
}

export async function run({ baseUrl }) {
  const teacherJar = createCookieJar();
  await login(teacherJar, baseUrl, "teacher_ada", "teach123");
  assert((await post(teacherJar, baseUrl, { csv: "username\nx" })).status === 403, "Expected teacher import 403");
  assert((await post(createCookieJar(), baseUrl, { csv: "username\nx" })).status === 401, "Expected anonymous 401");

  const admin = createCookieJar();
  await login(admin, baseUrl, "admin", "admin123");

  // Structure problems
  assert((await post(admin, baseUrl, { csv: "" })).status === 400, "Expected empty file 400");
  assert((await post(admin, baseUrl, { csv: "name,email\nA,a@x.org" })).status === 400, "Expected missing username column 400");

  const csv = [
    "﻿Username,Full Name,Email,Role,Class,Budget",
    'imp_teacher,"Importer, Teacher",imp.teacher@example.org,teacher,Import Class,25',
    "imp_s1,Imp One,,student,import class,$5.50",
    "imp_s2,Imp Two,,,Import Class,",
    "imp_s3,Imp Three,,student,,",
    "jane_smith,,,student,Import Class,",
  ].join("\r\n");

  // Preview writes nothing
  const preview = await post(admin, baseUrl, { csv, dryRun: true });
  assert(preview.status === 200 && preview.payload.dryRun === true, `Expected preview 200, got ${preview.status}`);
  assert(preview.payload.summary.create === 4, `Expected 4 to create, got ${preview.payload.summary.create}`);
  assert(preview.payload.summary.exists === 1, "Expected jane_smith to be reported as existing");
  assert(preview.payload.summary.errors === 0, `Expected no errors, got ${JSON.stringify(preview.payload.rows.filter((r) => r.errors.length))}`);
  assert(preview.payload.summary.newClasses.length === 1, "Expected one new class");
  assert(preview.payload.rows[0].fullName === "Importer, Teacher", "Expected a quoted comma to survive");
  assert(!preview.payload.credentials, "Expected no passwords in a preview");
  const listed = await admin.fetch(`${baseUrl}/api/admin/users`);
  assert(!(await listed.json()).users.some((user) => user.username === "imp_s1"), "Expected a preview to create nothing");

  // Bad rows block the whole import
  const bad = [
    "username,name,email,role,class,budget",
    "imp_ok,Fine,,student,,",
    "bad name,Space,,student,,",
    "imp_ok,Dupe,,student,,",
    "imp_x,Odd Role,,wizard,,",
    "imp_y,Overdrawn,,student,,-5",
    "imp_z,Both,,student;teacher,Some Class,",
    "admin,Existing,,,,3",
  ].join("\n");
  const badPreview = await post(admin, baseUrl, { csv: bad });
  assert(badPreview.payload.summary.errors === 6, `Expected 6 error rows, got ${badPreview.payload.summary.errors}`);
  const badRun = await post(admin, baseUrl, { csv: bad, dryRun: false });
  assert(badRun.status === 422 && badRun.payload.report, `Expected 422 with a report, got ${badRun.status}`);
  const afterBad = await (await admin.fetch(`${baseUrl}/api/admin/users`)).json();
  assert(!afterBad.users.some((user) => user.username === "imp_ok"), "Expected a failed import to write nothing");

  // The real import
  const run = await post(admin, baseUrl, { csv, dryRun: false });
  assert(run.status === 201, `Expected import 201, got ${run.status}: ${JSON.stringify(run.payload)}`);
  assert(run.payload.credentials.length === 4, "Expected 4 generated passwords");
  const imp = run.payload.credentials.find((c) => c.username === "imp_s1");
  assert((await login(createCookieJar(), baseUrl, "imp_s1", imp.password)).ok, "Expected an imported password to work");

  const users = (await (await admin.fetch(`${baseUrl}/api/admin/users`)).json()).users;
  const teacher = users.find((user) => user.username === "imp_teacher");
  assert(teacher.poolBalance === 25 && teacher.roles.join() === "teacher", "Expected the teacher pool funded with $25");
  assert(users.find((user) => user.username === "imp_s1").personalBalance === 5.5, "Expected $5.50 for imp_s1");
  assert(users.find((user) => user.username === "imp_s2").classes[0]?.name === "Import Class", "Expected imp_s2 in the class");
  assert(users.find((user) => user.username === "jane_smith").classes.some((c) => c.name === "Import Class"),
    "Expected existing jane_smith to be added to the class");
  assert(users.find((user) => user.username === "jane_smith").personalBalance === 8.4, "Expected jane's budget untouched");

  const classes = (await (await admin.fetch(`${baseUrl}/api/admin/classes`)).json()).classes;
  const importClass = classes.filter((c) => c.name === "Import Class");
  assert(importClass.length === 1, "Expected exactly one Import Class (case-insensitive match)");
  assert(importClass[0].teachers.length === 1 && importClass[0].students.length === 3, "Expected 1 teacher and 3 students in the class");

  // Running it again is safe: nobody new, passwords unchanged
  const again = await post(admin, baseUrl, { csv: csv.replace(/,\$5\.50|,25$/gm, ","), dryRun: false });
  assert(again.status === 201 && again.payload.credentials.length === 0, "Expected a re-run to create nobody");
  assert((await login(createCookieJar(), baseUrl, "imp_s1", imp.password)).ok, "Expected the original password to still work");
}
