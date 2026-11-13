import { getPool } from "./pool.js";
import { demoUsernames } from "./seedDemo.js";
import { log } from "../utils/log.js";

// Demo passwords are public (they are in this repo). At startup a production
// server disables any active demo account and ends its sessions, so the
// accounts can never be used even if a seed or restore brought them back.
// Disabled users cannot sign in, and their remaining sessions are dropped on
// the next request (auth/middleware.js).
export async function disableDemoUsersInProduction({ pool = getPool(), env = process.env } = {}) {
  if (env.NODE_ENV !== "production") {
    return [];
  }

  try {
    const result = await pool.query(
      `UPDATE users SET status = 'disabled'
       WHERE lower(username) = ANY($1::text[]) AND status = 'active'
       RETURNING id, username`,
      [demoUsernames()],
    );
    if (result.rows.length === 0) {
      return [];
    }
    await pool.query("DELETE FROM sessions WHERE sess->>'userId' = ANY($1::text[])", [
      result.rows.map((row) => String(row.id)),
    ]);
    const names = result.rows.map((row) => row.username).join(", ");
    log.error(`[security] disabled ${result.rows.length} demo account(s) with public passwords: ${names}`, {
      event: "security.demo_accounts_disabled",
      count: result.rows.length,
      usernames: names,
    });
    return result.rows.map((row) => row.username);
  } catch (error) {
    log.error("[security] demo account check failed", { event: "security.demo_check_failed", error: error.message });
    return [];
  }
}
