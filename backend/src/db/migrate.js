import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const migrationsDir = path.resolve(__dirname, "../../migrations");

// Arbitrary constant so concurrent runners (two deploys, server + CLI)
// serialize instead of applying the same migration twice.
const migrationLockId = 727274;

// Applies backend/migrations/NNN_name.sql files in order, each in its own
// transaction, recording them in schema_migrations. Returns names applied.
export async function runMigrations(pool, { log = () => {} } = {}) {
  const client = await pool.connect();

  try {
    await client.query("SELECT pg_advisory_lock($1)", [migrationLockId]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    const appliedRows = await client.query("SELECT name FROM schema_migrations");
    const applied = new Set(appliedRows.rows.map((row) => row.name));
    const files = (await readdir(migrationsDir))
      .filter((fileName) => /^\d{3}_[a-z0-9_]+\.sql$/.test(fileName))
      .sort();

    const newlyApplied = [];

    for (const fileName of files) {
      if (applied.has(fileName)) {
        continue;
      }

      const sql = await readFile(path.join(migrationsDir, fileName), "utf8");

      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
          fileName,
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(`Migration ${fileName} failed: ${error.message}`);
      }

      newlyApplied.push(fileName);
      log(`[db] applied migration ${fileName}`);
    }

    return newlyApplied;
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1)", [migrationLockId])
      .catch(() => {});
    client.release();
  }
}
