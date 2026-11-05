import { closePool, describeDatabase, getPool, useMigrationRole } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";

// Schema changes and wipes run as the schema owner (DATABASE_MIGRATE_URL) when set.
useMigrationRole();

try {
  const applied = await runMigrations(getPool(), { log: console.log });
  console.log(
    applied.length
      ? `Applied ${applied.length} migration(s) to ${describeDatabase()}`
      : `Database ${describeDatabase()} is up to date`,
  );
} catch (error) {
  console.error(error?.message || String(error));
  process.exitCode = 1;
} finally {
  await closePool();
}
