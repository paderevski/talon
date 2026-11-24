// Links (or unlinks) a Microsoft (Entra) account to a Talon user. Teachers,
// admins and anyone else who is not a plain student are never linked
// automatically at first Microsoft sign-in (services/entraSignIn.js); an
// admin links them here.
//   npm run db:link-entra --workspace backend -- --username <talon username> --oid <object id>
//   npm run db:link-entra --workspace backend -- --username <talon username> --unlink
// Against RDS, from a laptop: infra/scripts/db-run.sh -- npm run db:link-entra ...
//
// The object id (a GUID) is the user's "Object ID" in the Entra admin
// center (Users > the user). A refused first sign-in also logs it:
// auth.entra_refused with reason link-by-admin carries oid and the verified
// email (CloudWatch saved query "Failed logins"). Check that the object id
// belongs to the person who owns the Talon account before linking.
import { parseArgs } from "node:util";
import { closePool, describeDatabase, getPool, withTransaction } from "../src/db/pool.js";

const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const usage = "Usage: npm run db:link-entra --workspace backend -- --username <name> (--oid <object id> | --unlink)";

const { values } = parseArgs({
  options: {
    username: { type: "string" },
    oid: { type: "string" },
    unlink: { type: "boolean", default: false },
  },
});

const username = String(values.username ?? "").trim();
const oid = String(values.oid ?? "").trim().toLowerCase();
if (!username || values.unlink === Boolean(oid)) {
  console.error(usage);
  process.exit(1);
}
if (oid && !guidPattern.test(oid)) {
  console.error(`--oid must be the Microsoft object id (a GUID), got '${oid}'`);
  process.exit(1);
}

try {
  getPool();
  const message = await withTransaction(async (client) => {
    const found = await client.query(
      `SELECT u.id, u.username, u.email, u.status,
              ARRAY(SELECT r.role::text FROM user_roles r WHERE r.user_id = u.id ORDER BY r.role) AS roles
       FROM users u WHERE lower(u.username) = lower($1)
       FOR UPDATE`,
      [username],
    );
    const user = found.rows[0];
    if (!user) {
      throw new Error(`no Talon user '${username}'`);
    }
    const who = `'${user.username}' (${user.email || "no email"}; roles: ${user.roles.join(", ") || "none"}; ${user.status})`;

    if (values.unlink) {
      const removed = await client.query(
        "DELETE FROM user_identities WHERE user_id = $1 AND provider = 'entra' RETURNING subject",
        [user.id],
      );
      return removed.rows.length
        ? `Unlinked Microsoft account ${removed.rows[0].subject} from ${who}`
        : `${who} had no Microsoft account linked`;
    }

    const existing = await client.query(
      "SELECT i.user_id, i.subject, u.username FROM user_identities i JOIN users u ON u.id = i.user_id WHERE i.provider = 'entra' AND (i.subject = $1 OR i.user_id = $2)",
      [oid, user.id],
    );
    for (const row of existing.rows) {
      if (row.subject === oid && row.user_id === user.id) {
        return `${who} is already linked to ${oid}`;
      }
      if (row.subject === oid) {
        throw new Error(`Microsoft account ${oid} is already linked to '${row.username}'; unlink it there first`);
      }
      throw new Error(`${who} is already linked to Microsoft account ${row.subject}; run with --unlink first`);
    }
    await client.query(
      "INSERT INTO user_identities (user_id, provider, subject) VALUES ($1, 'entra', $2)",
      [user.id, oid],
    );
    return `Linked Microsoft account ${oid} to ${who}`;
  });
  console.log(`${message} in ${describeDatabase()}`);
} catch (error) {
  console.error(error?.message || String(error));
  process.exitCode = 1;
} finally {
  await closePool();
}
