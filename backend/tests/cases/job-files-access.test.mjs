import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assert, backendRoot, createCookieJar, insertTestJob, login, withTestDb } from "../lib/harness.mjs";

export const name = "job logs, files and downloads: owner only; download names cannot leave the job folder";

export async function run({ baseUrl }) {
  const executionId = `files-access-${Date.now()}`;
  const runDir = path.join(backendRoot, "data", "runs", executionId);
  await mkdir(path.join(runDir, "output"), { recursive: true });
  await writeFile(path.join(runDir, "output", "a.txt"), "result");
  await writeFile(path.join(backendRoot, "data", "runs", `${executionId}-outside.txt`), "secret");

  try {
    const { adminJob, studentJob } = await withTestDb(async (pool) => ({
      adminJob: await insertTestJob(pool, { owner: "admin", name: "files-admin", status: "completed", executionId }),
      studentJob: await insertTestJob(pool, { owner: "student_a1", name: "files-student", status: "completed", executionId }),
    }));

    const admin = createCookieJar();
    await login(admin, baseUrl, "admin", "admin123");
    const student = createCookieJar();
    await login(student, baseUrl, "student_g2", "student123");
    const teacher = createCookieJar();
    await login(teacher, baseUrl, "teacher_ada", "teach123");

    // The owner (admin here) can download.
    const own = await admin.fetch(`${baseUrl}/api/jobs/${adminJob}/files/download?name=a.txt`);
    assert(own.status === 200 && (await own.text()) === "result", `owner download ${own.status}`);

    // Another student sees nothing and can change nothing.
    const logs = await (await student.fetch(`${baseUrl}/api/jobs/${adminJob}/logs`)).json();
    assert(logs.noData === true && logs.lines.length === 0, `logs leaked: ${JSON.stringify(logs)}`);
    const files = await (await student.fetch(`${baseUrl}/api/jobs/${adminJob}/files`)).json();
    assert(files.noData === true && files.items.length === 0, `files leaked: ${JSON.stringify(files)}`);
    const download = await student.fetch(`${baseUrl}/api/jobs/${adminJob}/files/download?name=a.txt`);
    assert(download.status === 404, `non-owner download: expected 404, got ${download.status}`);
    // Reads of a job you cannot see answer "no data" (200), never the job.
    const read = await (await student.fetch(`${baseUrl}/api/jobs/${adminJob}`)).json();
    assert(read.job === null && read.execution === null && read.noData === true, `job leaked: ${JSON.stringify(read)}`);
    const cancel = await student.fetch(`${baseUrl}/api/jobs/${adminJob}/cancel`, { method: "POST" });
    assert(cancel.status === 404, `non-owner cancel: expected 404, got ${cancel.status}`);

    // A teacher may read a student's job but not hide it.
    const hide = await teacher.fetch(`${baseUrl}/api/jobs/${studentJob}`, { method: "DELETE" });
    assert(hide.status === 403, `teacher hide: expected 403, got ${hide.status}`);

    // Names that try to leave the job's folder.
    for (const name of ["../../x", `../${executionId}-outside.txt`, "..\\..\\x", "output/../../x"]) {
      const response = await admin.fetch(`${baseUrl}/api/jobs/${adminJob}/files/download?name=${encodeURIComponent(name)}`);
      assert(response.status === 400, `download '${name}': expected 400, got ${response.status}`);
    }
    // A leading "/" is dropped: the name is looked up inside the job's folder.
    for (const name of ["/etc/passwd", "nope.txt"]) {
      const response = await admin.fetch(`${baseUrl}/api/jobs/${adminJob}/files/download?name=${encodeURIComponent(name)}`);
      assert(response.status === 404, `download '${name}': expected 404, got ${response.status}`);
    }
  } finally {
    await rm(runDir, { recursive: true, force: true });
    await rm(path.join(backendRoot, "data", "runs", `${executionId}-outside.txt`), { force: true });
  }
}
