import pg from "pg";
import { parseIntoClientConfig } from "pg-connection-string";
import { Signer } from "@aws-sdk/rds-signer";
import { log } from "../utils/log.js";

// Connection comes from DATABASE_URL, falling back to the standard PG*
// environment variables / local socket defaults.
//   dev:  DATABASE_URL=postgres://localhost/talon_dev
//   EC2, local Postgres (peer auth over the Unix socket, no password):
//         DATABASE_URL=postgres://talon@%2Fvar%2Frun%2Fpostgresql/talon
//   EC2 with RDS: TLS with the certificate checked, and IAM authentication
//   (DATABASE_IAM_AUTH=true): each new connection's password is a 15-minute
//   token signed with the instance role, so no database password exists.
//         DATABASE_URL=postgres://talon_app@<endpoint>:5432/talon?sslmode=verify-full&sslrootcert=/etc/talon/rds-ca.pem
//         DATABASE_MIGRATE_URL=postgres://talon_migrate@<endpoint>:5432/talon?...  (schema owner)
//     The service connects as talon_app (rows only); migrations, the demo
//     seed and admin scripts call useMigrationRole() first.
//   Any server with a password instead: PGPASSWORD (pg reads it when the URL
//   has none), so talon.env holds no secret.
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

// Scripts that change the schema or wipe tables (migrations, the demo seed,
// db:create-admin) run as the schema owner when one is configured. Call
// before the first getPool().
export function useMigrationRole(env = process.env) {
  const migrateUrl = String(env.DATABASE_MIGRATE_URL ?? "").trim();
  if (migrateUrl) {
    env.DATABASE_URL = migrateUrl;
  }
}

const iamSigner = ({ hostname, port, username, region }) => new Signer({ hostname, port, username, region });

// pg connection settings for a URL. With DATABASE_IAM_AUTH=true the password
// is a function pg calls for every new connection; the URL is parsed into
// fields because pg lets a connection string's (empty) password override a
// password option.
export function connectionConfig(url = getDatabaseUrl(), env = process.env, { createSigner = iamSigner } = {}) {
  if (env.DATABASE_IAM_AUTH !== "true") {
    return { connectionString: url };
  }
  const config = parseIntoClientConfig(url);
  // RDS accepts IAM tokens only over TLS; the token must not leave unchecked.
  if (config.sslmode !== "verify-full") {
    throw new Error(`DATABASE_IAM_AUTH needs sslmode=verify-full in the URL (${describeDatabase(url)})`);
  }
  const signer = createSigner({
    hostname: config.host,
    port: Number(config.port || 5432),
    username: config.user,
    region: env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1",
  });
  return { ...config, password: () => signer.getAuthToken() };
}

export function getPool() {
  if (!pool) {
    const url = getDatabaseUrl();
    assertSecureDatabaseUrl(url);
    pool = new pg.Pool({
      ...connectionConfig(url),
      max: Number(process.env.PG_POOL_MAX || 10),
      // Fail instead of hanging when the database is unreachable (a remote
      // server can drop packets rather than refuse the connection).
      connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 10_000),
      // Keep idle connections for 5 minutes (pg's default is 10 s), so the
      // periodic database checks reuse one instead of opening a new
      // connection (TLS plus an IAM token) each time; one such connect once
      // took over the check's 2 s limit. A connection stays valid after its
      // IAM token expires.
      idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 300_000),
      // Database failover (RDS Multi-AZ): the endpoint moves to the standby
      // and the old primary's address goes silent, so queries on connections
      // to it hang instead of failing. A query that gets no answer in time
      // fails, and the pool then discards its connection (pg-pool removes a
      // client released with an error), so the next query connects to the
      // new primary. Measured 2026-11-05 without this: the pool stayed stuck
      // after the failover finished. Long enough for any real query here.
      query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS || 15_000),
      // TCP keepalive probes after 10 s idle (default: the OS's 2 hours), so
      // an idle connection to a vanished server is noticed and dropped.
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
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
  // A connection whose ROLLBACK fails (dead after a failover, or timed out)
  // is discarded, never handed to the next caller.
  let broken = false;

  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {
      broken = true;
    });
    throw error;
  } finally {
    client.release(broken);
  }
}
