// Deletes ALL data (users, classes, sessions, jobs, connections, ledger):
// the schema stays. Run once at go-live to drop the demo data, then create
// the first admin with db:create-admin. Cannot be undone (RDS point-in-time
// restore is the only way back).
//   npm run db:wipe --workspace backend -- --yes-delete-everything [--allow-running-jobs]
import { closePool, describeDatabase, getPool, useMigrationRole } from "../src/db/pool.js";
import { wipeAllData } from "../src/db/wipe.js";

// Wipes run as the schema owner (DATABASE_MIGRATE_URL) when set.
useMigrationRole();

if (!process.argv.includes("--yes-delete-everything")) {
  console.error("Deletes every user, class, session and job. Rerun with --yes-delete-everything.");
  process.exit(2);
}

try {
  const counts = await wipeAllData(getPool(), {
    allowRunningJobs: process.argv.includes("--allow-running-jobs"),
  });
  console.log(`Wiped ${describeDatabase()}: ${counts.users} users, ${counts.classes} classes, ${counts.jobs} jobs deleted.`);
  console.log("Next: npm run db:create-admin --workspace backend -- --username <you@lcps.org>");
} catch (error) {
  console.error(error?.message || String(error));
  process.exitCode = 1;
} finally {
  await closePool();
}
