import { withTransaction } from "./pool.js";

// Refuses while EC2 jobs are queued or running: deleting their rows makes the
// reconciler terminate their instances ("no job row") and their results in
// S3 could no longer be found from the app. allowRunningJobs skips the check.
export async function assertNoActiveEc2Jobs(client, { allowRunningJobs = false } = {}) {
  if (allowRunningJobs) {
    return;
  }
  const running = await client.query(
    `SELECT id, name, status FROM jobs
     WHERE execution_provider = 'ec2' AND status IN ('queued', 'running')
     ORDER BY created_at LIMIT 5`,
  );
  if (running.rows.length > 0) {
    throw new Error(
      `Refusing to wipe: EC2 jobs still queued or running (${running.rows
        .map((row) => `${row.id} ${row.name} ${row.status}`)
        .join(", ")}). Deleting them makes the reconciler terminate their instances. ` +
        "Wait for them to finish or cancel them, or pass --allow-running-jobs.",
    );
  }
}

// Every user, class, session and job, and everything that hangs off them
// (roles, identities, connections, ledger accounts and entries, results).
export async function truncateAllData(client) {
  await client.query("TRUNCATE users, classes, sessions, jobs CASCADE");
}

// Empties the database (schema and migrations stay). Used once at go-live to
// start clean; afterwards, create an admin with db:create-admin.
export async function wipeAllData(pool, { allowRunningJobs = false } = {}) {
  return withTransaction(
    async (client) => {
      await assertNoActiveEc2Jobs(client, { allowRunningJobs });
      const counts = await client.query(
        "SELECT (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM classes)::int AS classes, (SELECT count(*) FROM jobs)::int AS jobs",
      );
      await truncateAllData(client);
      return counts.rows[0];
    },
    { pool },
  );
}
