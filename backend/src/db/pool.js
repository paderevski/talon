import pg from "pg";
import { log } from "../utils/log.js";

// Connection comes from DATABASE_URL, falling back to the standard PG*
// environment variables / local socket defaults.
//   dev:  DATABASE_URL=postgres://localhost/talon_dev
//   EC2, local Postgres (peer auth over the Unix socket, no password):
//         DATABASE_URL=postgres://talon@%2Fvar%2Frun%2Fpostgresql/talon
//   EC2, remote Postgres (RDS) over TCP with TLS:
//         DATABASE_URL=postgres://talon@<endpoint>:5432/talon?sslmode=verify-full&sslrootcert=/etc/talon/rds-ca.pem
//         PGPASSWORD=<from SSM, written to secrets.env by talon-load-secrets>
//     The password stays out of the URL so talon.env holds no secret; pg
//     reads PGPASSWORD when the URL has none.
const defaultDatabaseUrl = "postgres://localhost/talon_dev";
const loopbackHosts = new Set(["", "localhost", "127.0.0.1", "::1", "[::1]"]);

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

// How a URL reaches the server: "socket" (Unix socket, e.g. peer auth),
// "loopback" (TCP to this machine), "tls" (remote, certificate verified) or
// "plaintext" (remote without verify-full: password and data exposed).
export function databaseTransport(url = getDatabaseUrl()) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "plaintext";
  }
  const host = decodeURIComponent(parsed.searchParams.get("host") ?? parsed.hostname);
  if (host.startsWith("/")) {
    return "socket";
  }
  if (loopbackHosts.has(host.toLowerCase())) {
    return "loopback";
  }
  return parsed.searchParams.get("sslmode") === "verify-full" ? "tls" : "plaintext";
}

// In production a database on another machine must be reached over TLS with
// the server certificate checked (sslmode=verify-full plus sslrootcert).
export function assertSecureDatabaseUrl(url = getDatabaseUrl(), env = process.env) {
  if (env.NODE_ENV === "production" && databaseTransport(url) === "plaintext") {
    throw new Error(
      `DATABASE_URL points at a remote server without sslmode=verify-full (${describeDatabase(url)}); ` +
        "refusing to send the database password unencrypted when NODE_ENV=production",
    );
  }
}

export function getPool() {
  if (!pool) {
    const connectionString = getDatabaseUrl();
    assertSecureDatabaseUrl(connectionString);
    pool = new pg.Pool({
      connectionString,
      max: Number(process.env.PG_POOL_MAX || 10),
      // Fail instead of hanging when the database is unreachable (a remote
      // server can drop packets rather than refuse the connection).
      connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 10_000),
      keepAlive: true,
    });
    pool.on("error", (error) => {
      log.error("database idle client error", { event: "db.idle_client_error", error: error.message });
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
