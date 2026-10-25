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

  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET is required when NODE_ENV=production");
  }

  // Dev only: random per process, so everyone is signed out on restart.
  console.warn(
    "[session] SESSION_SECRET not set; using a random secret (sessions end on restart)",
  );
  return randomBytes(32).toString("hex");
}

function createStore() {
  const PgSessionStore = connectPgSimple(session);
  return new PgSessionStore({
    pool: getPool(),
    tableName: "sessions",
    createTableIfMissing: false, // created by migrations/001_users.sql
  });
}

export function createSessionMiddleware() {
  return session({
    name: sessionCookieName,
    secret: getSessionSecret(),
    store: createStore(),
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
