import { getPool } from "./pool.js";
import { demoUsernames } from "./seedDemo.js";
import { log } from "../utils/log.js";

// Logs loudly at startup if a production server has demo accounts, whose
// passwords are public in this repo.
export async function warnIfDemoUsersInProduction({ pool = getPool() } = {}) {
  if (process.env.NODE_ENV !== "production") {
    return;
  }

  try {
    const result = await pool.query(
      "SELECT username FROM users WHERE lower(username) = ANY($1::text[]) AND status = 'active' ORDER BY username",
      [demoUsernames()],
    );
    if (result.rows.length > 0) {
      const names = result.rows.map((row) => row.username).join(", ");
      const message = `[security] ${result.rows.length} demo account(s) with PUBLIC passwords are active: ${names}`;
      const fields = { event: "security.demo_accounts_active", count: result.rows.length, usernames: names };
      if (process.env.TALON_ALLOW_DEMO_SEED === "true") {
        log.warn(`${message} (allowed: TALON_ALLOW_DEMO_SEED=true)`, fields);
      } else {
        log.error(`${message}. Disable or delete them before exposing this server.`, fields);
      }
    }
  } catch (error) {
    log.error("[security] demo account check failed", { event: "security.demo_check_failed", error: error.message });
  }
}
