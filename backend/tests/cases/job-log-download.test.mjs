import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assert, backendRoot, createCookieJar, insertTestJob, login, withTestDb } from "../lib/harness.mjs";

export const name = "job log download: the whole log as <job name>.log, owner only, 404 when there is none";

export async function run({ baseUrl }) {
  const executionId = `log-download-${Date.now()}`;
  const runDir = path.join(backendRoot, "data", "runs", executionId);
  const log = Array.from({ length: 5000 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "combined.log"), log);

  try {
    const { withLog, withoutLog } = await withTestDb(async (pool) => ({
      withLog: await insertTestJob(pool, { owner: "admin", name: "train v2/final", status: "completed", executionId }),
      withoutLog: await insertTestJob(pool, { owner: "admin", name: "no-log", status: "failed", executionId: `${executionId}-missing` }),
    }));

    const admin = createCookieJar();
    await login(admin, baseUrl, "admin", "admin123");
    const student = createCookieJar();
    await login(student, baseUrl, "student_g2", "student123");

    // The owner gets every line, as a text attachment named after the job.
    const own = await admin.fetch(`${baseUrl}/api/jobs/${withLog}/logs/download`);
    const body = await own.text();
    assert(own.status === 200, `owner log download: ${own.status}`);
    assert(body === log, `log body: expected ${log.length} chars, got ${body.length}`);
    const disposition = own.headers.get("content-disposition") || "";
    assert(disposition.includes('filename="train-v2-final.log"'), `download name: ${disposition}`);
    assert((own.headers.get("content-type") || "").startsWith("text/plain"), `type: ${own.headers.get("content-type")}`);

    // Someone who cannot see the job gets the same answer as for a missing one.
    const other = await student.fetch(`${baseUrl}/api/jobs/${withLog}/logs/download`);
    assert(other.status === 404, `non-owner log download: expected 404, got ${other.status}`);

    // No log on disk: 404 with a message, not a 500.
    const missing = await admin.fetch(`${baseUrl}/api/jobs/${withoutLog}/logs/download`);
    assert(missing.status === 404, `missing log: expected 404, got ${missing.status}`);
    assert((await missing.json()).message === "Log not found", "missing log message");
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
}
