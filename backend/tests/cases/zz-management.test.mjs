import { assert, createCookieJar, login } from "../lib/harness.mjs";

// Runs last (name sorts after the others) because it adds users and classes,
// which would change the seeded counts other tests check.
export const name = "admin creates users, classes and budgets; teacher allocates";

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
  // Authorization
  const anonymous = await send(createCookieJar(), baseUrl, "GET", "/api/admin/users");
  assert(anonymous.status === 401, `Expected anonymous 401, got ${anonymous.status}`);
  const student = createCookieJar();
  await login(student, baseUrl, "jane_smith", "talon123");
  for (const [method, path] of [
    ["GET", "/api/admin/users"],
    ["POST", "/api/admin/users"],
    ["POST", "/api/admin/budget/adjustments"],
    ["POST", "/api/teacher/allocations"],
  ]) {
    const denied = await send(student, baseUrl, method, path, {});
    assert(denied.status === 403, `Expected student 403 for ${method} ${path}, got ${denied.status}`);
  }

  const admin = createCookieJar();
  await login(admin, baseUrl, "admin", "admin123");

  // Create users
  const bad = await send(admin, baseUrl, "POST", "/api/admin/users", { username: "x y", roles: ["student"] });
  assert(bad.status === 400, `Expected invalid username 400, got ${bad.status}`);
  const noRole = await send(admin, baseUrl, "POST", "/api/admin/users", { username: "mgmt_norole", roles: [] });
  assert(noRole.status === 400, `Expected missing role 400, got ${noRole.status}`);

  const teacher = await send(admin, baseUrl, "POST", "/api/admin/users", {
    username: "mgmt_teacher",
    fullName: "Mgmt Teacher",
    email: "mgmt.teacher@example.org",
    roles: ["teacher"],
  });
  assert(teacher.status === 201 && teacher.payload.password, "Expected teacher created with a password");
  const pupil = await send(admin, baseUrl, "POST", "/api/admin/users", {
    username: "mgmt_pupil",
    fullName: "Mgmt Pupil",
    roles: ["student"],
  });
  assert(pupil.status === 201, `Expected pupil created, got ${pupil.status}`);
  const outsider = await send(admin, baseUrl, "POST", "/api/admin/users", {
    username: "mgmt_outsider",
    roles: ["student"],
  });
  const duplicate = await send(admin, baseUrl, "POST", "/api/admin/users", {
    username: "MGMT_TEACHER",
    roles: ["student"],
  });
  assert(duplicate.status === 409, `Expected duplicate username 409, got ${duplicate.status}`);

  const teacherJar = createCookieJar();
  const teacherLogin = await login(teacherJar, baseUrl, "mgmt_teacher", teacher.payload.password);
  assert(teacherLogin.ok, `Expected generated password to work, got ${teacherLogin.status}`);

  const listed = await send(admin, baseUrl, "GET", "/api/admin/users");
  const listedTeacher = listed.payload.users.find((user) => user.username === "mgmt_teacher");
  assert(listedTeacher?.poolBalance === 0, "Expected a new teacher to have a $0 pool");
  assert(listedTeacher.email === "mgmt.teacher@example.org", "Expected email to be listed");

  // Classes and membership
  const created = await send(admin, baseUrl, "POST", "/api/admin/classes", {
    name: "Mgmt Class",
    term: "2026-27",
    teacherId: teacher.payload.id,
  });
  assert(created.status === 201, `Expected class created, got ${created.status}`);
  const classId = created.payload.id;

  const wrongRole = await send(admin, baseUrl, "POST", `/api/admin/classes/${classId}/members`, {
    userId: pupil.payload.id,
    memberRole: "teacher",
  });
  assert(wrongRole.status === 409, `Expected student-as-teacher 409, got ${wrongRole.status}`);
  const added = await send(admin, baseUrl, "POST", `/api/admin/classes/${classId}/members`, {
    userId: pupil.payload.id,
    memberRole: "student",
  });
  assert(added.status === 201, `Expected member added, got ${added.status}`);

  const blocked = await send(admin, baseUrl, "PATCH", `/api/admin/users/${teacher.payload.id}`, {
    roles: ["student"],
  });
  assert(blocked.status === 409, `Expected removing the teacher role mid-class 409, got ${blocked.status}`);

  // Budgets
  const noTeacherPool = await send(admin, baseUrl, "POST", "/api/admin/budget/adjustments", {
    userId: pupil.payload.id,
    target: "pool",
    direction: "increase",
    amount: 5,
  });
  assert(noTeacherPool.status === 409, `Expected pool grant to a student 409, got ${noTeacherPool.status}`);
  for (const amount of [0, -3, "abc", 1_000_000]) {
    const invalid = await send(admin, baseUrl, "POST", "/api/admin/budget/adjustments", {
      userId: teacher.payload.id,
      target: "pool",
      direction: "increase",
      amount,
    });
    assert(invalid.status === 400, `Expected amount ${amount} rejected with 400, got ${invalid.status}`);
  }
  const funded = await send(admin, baseUrl, "POST", "/api/admin/budget/adjustments", {
    userId: teacher.payload.id,
    target: "pool",
    direction: "increase",
    amount: 20.5,
  });
  assert(funded.status === 201, `Expected pool grant, got ${funded.status}`);

  const allocate = (studentUsername, amount) =>
    send(teacherJar, baseUrl, "POST", "/api/teacher/allocations", { studentUsername, amount });
  assert((await allocate("mgmt_pupil", 8.25)).status === 201, "Expected allocation to succeed");
  assert((await allocate("mgmt_outsider", 1)).status === 404, "Expected allocation outside the class to 404");
  assert((await allocate("mgmt_pupil", 50)).status === 409, "Expected over-allocation to be refused with 409");

  const roster = await send(teacherJar, baseUrl, "GET", "/api/teacher/students");
  assert(roster.payload.roster.teacher.poolBalance === 12.25, "Expected pool to drop to $12.25");
  const pupilRow = roster.payload.roster.classes[0].students.find((s) => s.username === "mgmt_pupil");
  assert(pupilRow.tokensRemaining === 8.25, "Expected the student to hold $8.25");

  // Decrease: pool and personal budgets, never below zero
  const adjust = (userId, target, direction, amount) =>
    send(admin, baseUrl, "POST", "/api/admin/budget/adjustments", { userId, target, direction, amount });
  assert((await adjust(teacher.payload.id, "pool", "decrease", 100)).status === 409,
    "Expected removing more than the pool holds to be refused with 409");
  assert((await adjust(teacher.payload.id, "pool", "sideways", 1)).status === 400, "Expected bad direction 400");
  assert((await adjust(teacher.payload.id, "pool", "decrease", 2.25)).status === 201, "Expected pool decrease");
  assert((await adjust(pupil.payload.id, "personal", "decrease", 1.25)).status === 201, "Expected personal decrease");
  assert((await adjust(pupil.payload.id, "personal", "decrease", 50)).status === 409,
    "Expected removing more than a student holds to be refused with 409");
  const afterDecrease = await send(teacherJar, baseUrl, "GET", "/api/teacher/students");
  assert(afterDecrease.payload.roster.teacher.poolBalance === 10, "Expected pool at $10.00 after the decrease");
  const pupilAfter = afterDecrease.payload.roster.classes[0].students.find((s) => s.username === "mgmt_pupil");
  assert(pupilAfter.tokensRemaining === 7, "Expected the student at $7.00 after the decrease");

  // Disable signs the user out; reset password replaces the old one
  const pupilJar = createCookieJar();
  await login(pupilJar, baseUrl, "mgmt_pupil", pupil.payload.password);
  assert((await pupilJar.fetch(`${baseUrl}/api/auth/me`)).ok, "Expected pupil to be signed in");
  await send(admin, baseUrl, "PATCH", `/api/admin/users/${pupil.payload.id}`, { status: "disabled" });
  assert((await pupilJar.fetch(`${baseUrl}/api/auth/me`)).status === 401, "Expected disabled user's session to end");
  assert((await login(createCookieJar(), baseUrl, "mgmt_pupil", pupil.payload.password)).status === 401,
    "Expected disabled user to be unable to sign in");
  await send(admin, baseUrl, "PATCH", `/api/admin/users/${pupil.payload.id}`, { status: "active" });

  const reset = await send(admin, baseUrl, "POST", `/api/admin/users/${pupil.payload.id}/reset-password`);
  assert(reset.status === 200 && reset.payload.password !== pupil.payload.password, "Expected a new password");
  assert((await login(createCookieJar(), baseUrl, "mgmt_pupil", pupil.payload.password)).status === 401,
    "Expected the old password to stop working");
  assert((await login(createCookieJar(), baseUrl, "mgmt_pupil", reset.payload.password)).ok,
    "Expected the new password to work");

  // Self-protection
  const adminId = (await send(admin, baseUrl, "GET", "/api/auth/me")).payload.user.id;

  // Resetting your own password keeps your session so the new password can be shown
  const selfReset = await send(admin, baseUrl, "POST", `/api/admin/users/${adminId}/reset-password`);
  assert(selfReset.status === 200 && selfReset.payload.password, "Expected self reset to return a password");
  assert((await admin.fetch(`${baseUrl}/api/auth/me`)).ok, "Expected own session to survive a self reset");
  assert((await login(createCookieJar(), baseUrl, "admin", selfReset.payload.password)).ok,
    "Expected the reset admin password to work");
  assert((await login(createCookieJar(), baseUrl, "admin", "admin123")).status === 401,
    "Expected the old admin password to stop working");
  // Put the seeded password back; later tests sign in with it
  const restored = await send(admin, baseUrl, "POST", "/api/auth/password", {
    currentPassword: selfReset.payload.password,
    newPassword: "admin123",
  });
  assert(restored.status === 200, `Expected admin password restore, got ${restored.status}`);
  assert((await send(admin, baseUrl, "PATCH", `/api/admin/users/${adminId}`, { status: "disabled" })).status === 400,
    "Expected admin to be unable to disable themself");
  assert((await send(admin, baseUrl, "PATCH", `/api/admin/users/${adminId}`, { roles: ["teacher"] })).status === 400,
    "Expected admin to be unable to drop their own admin role");
  assert((await send(admin, baseUrl, "GET", "/api/admin/users/not-a-uuid/x")).status === 404,
    "Expected unknown route 404");

  // Archive hides the class from the teacher
  await send(admin, baseUrl, "PATCH", `/api/admin/classes/${classId}`, { archived: true });
  const afterArchive = await send(teacherJar, baseUrl, "GET", "/api/teacher/students");
  assert(afterArchive.payload.roster.classes.length === 0, "Expected archived class to disappear for the teacher");

  // Change own password
  const wrongCurrent = await send(teacherJar, baseUrl, "POST", "/api/auth/password", {
    currentPassword: "nope",
    newPassword: "a-brand-new-pass",
  });
  assert(wrongCurrent.status === 403, `Expected wrong current password 403, got ${wrongCurrent.status}`);
  const tooShort = await send(teacherJar, baseUrl, "POST", "/api/auth/password", {
    currentPassword: teacher.payload.password,
    newPassword: "short",
  });
  assert(tooShort.status === 400, `Expected short password 400, got ${tooShort.status}`);
  const changed = await send(teacherJar, baseUrl, "POST", "/api/auth/password", {
    currentPassword: teacher.payload.password,
    newPassword: "a-brand-new-pass",
  });
  assert(changed.status === 200, `Expected password change, got ${changed.status}`);
  assert((await teacherJar.fetch(`${baseUrl}/api/auth/me`)).ok, "Expected own session to survive a password change");
  assert((await login(createCookieJar(), baseUrl, "mgmt_teacher", "a-brand-new-pass")).ok,
    "Expected the new password to sign in");
}
