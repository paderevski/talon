import { apiFetch, assert, withTestDb } from "../lib/harness.mjs";

export const name = "cancelling an EC2 job that is still being prepared finishes it at once (any web server)";

export async function run({ baseUrl }) {
  // An EC2 job between submit and launch: queued, no execution ref yet.
  const jobId = await withTestDb(async (pool) => {
    const { rows } = await pool.query(
      `INSERT INTO jobs (owner_user_id, name, source_label, status, execution_provider, launch_progress, launch_progress_at)
       SELECT id, 'preparing-cancel', 'o/r', 'queued', 'ec2', 'Copied 3 of 9 files', now() FROM users WHERE username = 'admin'
       RETURNING id`,
    );
    return rows[0].id;
  });

  const listed = await (await apiFetch(`${baseUrl}/api/jobs/${jobId}`)).json();
  const job = listed.job ?? listed;
  assert(job.launch?.progress === "Copied 3 of 9 files" && !job.executionRef, `preparing job ${JSON.stringify(job.launch)}`);

  const cancel = await apiFetch(`${baseUrl}/api/jobs/${jobId}/cancel`, { method: "POST" });
  const body = await cancel.json();
  assert(cancel.ok && body.result?.state === "cancelled", `cancel: ${cancel.status} ${JSON.stringify(body)}`);

  const after = await withTestDb(async (pool) => (await pool.query("SELECT status, result_sync_key FROM jobs WHERE id = $1", [jobId])).rows[0]);
  assert(after.status === "failed" && after.result_sync_key === "cancelled-before-launch", `after ${JSON.stringify(after)}`);

  // Cancelling it again is refused: it has finished.
  const again = await apiFetch(`${baseUrl}/api/jobs/${jobId}/cancel`, { method: "POST" });
  assert(again.status === 409, `second cancel should be 409, got ${again.status}`);
}
