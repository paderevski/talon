import pg from "pg";

// Connection comes from DATABASE_URL, falling back to the standard PG*
// environment variables / local socket defaults.
//   dev:  DATABASE_URL=postgres://localhost/talon_dev
//   EC2:  DATABASE_URL=postgresql:///talon?host=/var/run/postgresql  (peer auth)
const defaultDatabaseUrl = "postgres://localhost/talon_dev";

let pool = null;

export function getDatabaseUrl() {
  return String(process.env.DATABASE_URL ?? "").trim() || defaultDatabaseUrl;
}

export function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: getDatabaseUrl(),
      max: Number(process.env.PG_POOL_MAX || 10),
    });
    pool.on("error", (error) => {
      console.error(`[db] idle client error: ${error.message}`);
    });
  }

  return pool;
}

export async function closePool() {
  if (pool) {
    const closing = pool;
    pool = null;
    await closing.end();
  }
}

export async function withTransaction(fn, { pool: targetPool = getPool() } = {}) {
  const client = await targetPool.connect();

  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
