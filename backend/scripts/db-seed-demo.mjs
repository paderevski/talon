import { closePool, describeDatabase, getPool, useMigrationRole } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";
import { seedDemoUsers } from "../src/db/seedDemo.js";

// Schema changes and wipes run as the schema owner (DATABASE_MIGRATE_URL) when set.
useMigrationRole();

try {
  const pool = getPool();
  await runMigrations(pool, { log: console.log });
  // --replace-all: wipe every user, not only demo ones; --allow-running-jobs:
  // wipe even while EC2 jobs are queued or running (see seedDemo.js).
  const counts = await seedDemoUsers(pool, {
    replaceAll: process.argv.includes("--replace-all"),
    allowRunningJobs: process.argv.includes("--allow-running-jobs"),
  });
  console.log(`Demo users seeded into ${describeDatabase()}`);
  console.log(JSON.stringify(counts, null, 2));
  console.log("Passwords: admin123 (admin), teach123 (teachers), student123 (students), talon123 (jane_smith)");
} catch (error) {
  console.error(error?.message || String(error));
  process.exitCode = 1;
} finally {
  await closePool();
}
