// Creates (or resets the password of) a local admin account with a random
// password, printed once. Never put real admin passwords in the repo.
//   npm run db:create-admin --workspace backend -- --username you@lcps.org --name "Your Name"
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { closePool, getDatabaseUrl, getPool, withTransaction } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";
import { ensureAccount } from "../src/budget/ledger.js";
import { createPasswordHash } from "../src/utils/passwords.js";

const { values } = parseArgs({
  options: {
    username: { type: "string" },
    name: { type: "string" },
    email: { type: "string" },
  },
});

const username = String(values.username ?? "").trim();
if (!username) {
  console.error('Usage: npm run db:create-admin -- --username <name-or-email> [--name "Display Name"] [--email you@lcps.org]');
  process.exit(1);
}

const email = String(values.email ?? (username.includes("@") ? username : "")).trim() || null;
const displayName = String(values.name ?? "").trim() || username;
const password = randomBytes(18).toString("base64url");

try {
  const pool = getPool();
  await runMigrations(pool, { log: console.log });

  const created = await withTransaction(async (client) => {
    const existing = await client.query("SELECT id FROM users WHERE lower(username) = lower($1)", [username]);
    let userId = existing.rows[0]?.id;
    const isNew = !userId;

    if (isNew) {
      const inserted = await client.query(
        "INSERT INTO users (username, email, display_name) VALUES ($1, $2, $3) RETURNING id",
        [username, email, displayName],
      );
      userId = inserted.rows[0].id;
    }

    await client.query(
      "INSERT INTO user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING",
      [userId],
    );
    await client.query(
      `
        INSERT INTO user_identities (user_id, provider, subject, password_hash)
        VALUES ($1, 'local', lower($2), $3)
        ON CONFLICT (provider, subject) DO UPDATE SET password_hash = EXCLUDED.password_hash
      `,
      [userId, username, createPasswordHash(password)],
    );
    await client.query("UPDATE users SET status = 'active', updated_at = now() WHERE id = $1", [userId]);
    await ensureAccount(client, userId, "personal");
    return isNew;
  });

  console.log(`${created ? "Created" : "Updated"} admin '${username}' in ${getDatabaseUrl()}`);
  console.log(`Password (shown once, store it in a password manager): ${password}`);
} catch (error) {
  console.error(error?.message || String(error));
  process.exitCode = 1;
} finally {
  await closePool();
}
