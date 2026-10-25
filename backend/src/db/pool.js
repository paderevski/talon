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

// Safe to print: the connection URL with any password masked. Use this in
// logs and console output, never getDatabaseUrl().
export function describeDatabase(url = getDatabaseUrl()) {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = "****";
    }
    for (const key of ["password", "sslpassword"]) {
      if (parsed.searchParams.has(key)) {
        parsed.searchParams.set(key, "****");
      }
    }
    return decodeURI(parsed.toString());
  } catch {
    return "(unparseable DATABASE_URL, hidden)";
  }
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
