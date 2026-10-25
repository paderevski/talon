import { randomBytes } from "node:crypto";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { getPool } from "../db/pool.js";

const sessionIdleMs = 7 * 24 * 60 * 60 * 1000; // 7 days of inactivity
export const sessionCookieName = "talon.sid";

function getSessionSecret() {
  const configured = String(process.env.SESSION_SECRET ?? "").trim();
  if (configured) {
    return configured;
  }

  // Random per process: still secure, but everyone is signed out on restart.
  console.warn(
    "[session] SESSION_SECRET not set; using a random secret (sessions end on restart)",
  );
  return randomBytes(32).toString("hex");
}

function createStore(provider) {
  if (provider === "postgres") {
    const PgSessionStore = connectPgSimple(session);
    return new PgSessionStore({
      pool: getPool(),
      tableName: "sessions",
      createTableIfMissing: false, // created by migrations/001_users.sql
    });
  }

  // SQLite provider: in-memory store. Fine for dev/tests and the single-
  // process demo box; sessions end on restart. Use Postgres for real use.
  if (process.env.NODE_ENV === "production") {
    console.warn("[session] using in-memory sessions; set USERS_REPOSITORY_PROVIDER=postgres");
  }
  return undefined;
}

export function createSessionMiddleware({
  provider = String(process.env.USERS_REPOSITORY_PROVIDER || "sqlite").trim().toLowerCase(),
} = {}) {
  return session({
    name: sessionCookieName,
    secret: getSessionSecret(),
    store: createStore(provider),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.SESSION_COOKIE_SECURE === "true",
      maxAge: sessionIdleMs,
    },
  });
}
