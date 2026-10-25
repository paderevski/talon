import { closePool, describeDatabase, getPool } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";
import { seedDemoUsers } from "../src/db/seedDemo.js";

try {
  const pool = getPool();
  await runMigrations(pool, { log: console.log });
  const counts = await seedDemoUsers(pool);
  console.log(`Demo users seeded into ${describeDatabase()}`);
  console.log(JSON.stringify(counts, null, 2));
  console.log("Passwords: admin123 (admin), teach123 (teachers), student123 (students), talon123 (jane_smith)");
} catch (error) {
  console.error(error?.message || String(error));
  process.exitCode = 1;
} finally {
  await closePool();
}
