import { closePool, describeDatabase, getPool } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";

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
