// Clears the failed-login lock for an account.
//   npm run db:unlock --workspace backend -- <username>
import { closePool, getPool } from "../src/db/pool.js";
import { clearFailures, throttleKey } from "../src/auth/loginThrottle.js";

const username = process.argv[2];
if (!username) {
  console.error("Usage: npm run db:unlock --workspace backend -- <username>");
  process.exit(1);
}

try {
  await clearFailures(username, { pool: getPool() });
  console.log(`Cleared failed-login lock for '${throttleKey(username)}'`);
} catch (error) {
  console.error(error?.message || String(error));
  process.exitCode = 1;
} finally {
  await closePool();
}
