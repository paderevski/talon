import { randomBytes } from "node:crypto";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { getPool } from "../db/pool.js";
import { log } from "../utils/log.js";

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
  log.warn("SESSION_SECRET not set; using a random secret (sessions end on restart)", {
    event: "session.random_secret",
  });
  return randomBytes(32).toString("hex");
}

// Secure flag on the session cookie. "auto" (the production default) marks it
// Secure whenever the request arrived over HTTPS: through the public ALB that
// is every request (HTTP:80 redirects), decided by the ALB's
// X-Forwarded-Proto, which Express trusts only from nginx and the VPC
// (trustedProxies.js). The plain-HTTP SSM tunnel still gets a working cookie.
// SESSION_COOKIE_SECURE=true forces Secure, false turns it off.
export function sessionCookieSecure(env = process.env) {
  const value = String(env.SESSION_COOKIE_SECURE ?? "").trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "auto") return "auto";
  return env.NODE_ENV === "production" ? "auto" : false;
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
      secure: sessionCookieSecure(),
      maxAge: sessionIdleMs,
    },
  });
}
