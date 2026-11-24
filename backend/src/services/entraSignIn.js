import { withTransaction } from "../db/pool.js";
import { setRoles } from "./management.js";

// Matches a verified Microsoft sign-in (auth/entra.js) to a Talon user, in
// one transaction:
//   1. The Microsoft account (its object id, oid) is already linked: that
//      user. Email changes on the Microsoft side do not matter any more.
//   2. Otherwise, by verified email (auth/entra.js trusts only an address
//      Microsoft marks verified): the one user whose email, or username, is
//      that address gets the Microsoft account linked (first sign-in of a
//      student an admin created or imported). Only plain students are
//      linked this way: a user with any other role (teacher, admin) or no
//      role is refused with link-by-admin, and an admin links them with
//      scripts/db-link-entra.mjs. A user already linked to a Microsoft
//      account is not re-linked (an address can move to another person;
//      the database also allows one Microsoft account per user); two users
//      matching is refused.
//   3. Otherwise a new student account (unless policy.autoCreate is off).
//      IT's user assignment on the app registration decides who gets here.
// Email linking and new accounts are limited to policy.emailDomains when set.
// Returns { userId, outcome: signed-in | linked | created }; throws
// EntraSignInError with a code the login page explains.

export class EntraSignInError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "EntraSignInError";
    this.code = code;
  }
}

const domainOf = (email) => email.slice(email.lastIndexOf("@") + 1);

export async function signInWithEntra({ oid, email, name }, policy = {}, { pool } = {}) {
  const { autoCreate = true, emailDomains = [] } = policy;
  if (!oid) {
    throw new EntraSignInError("failed", "no Microsoft object id");
  }

  try {
    return await withTransaction(async (client) => {
      const linked = await client.query(
        `SELECT i.id, i.user_id, u.status
         FROM user_identities i JOIN users u ON u.id = i.user_id
         WHERE i.provider = 'entra' AND i.subject = $1
         FOR UPDATE OF i`,
        [oid],
      );
      if (linked.rows.length) {
        const { id, user_id: userId, status } = linked.rows[0];
        if (status !== "active") {
          throw new EntraSignInError("disabled", "the linked Talon account is disabled");
        }
        await client.query("UPDATE user_identities SET last_used_at = now() WHERE id = $1", [id]);
        await client.query("UPDATE users SET last_login_at = now() WHERE id = $1", [userId]);
        return { userId, outcome: "signed-in" };
      }

      if (!email) {
        throw new EntraSignInError("no-email", "Microsoft sent no verified email address");
      }
      if (emailDomains.length && !emailDomains.includes(domainOf(email))) {
        throw new EntraSignInError("domain", `email domain ${domainOf(email)} is not allowed`);
      }

      const matches = await client.query(
        `SELECT u.id, u.status, u.email,
                EXISTS (SELECT 1 FROM user_identities e WHERE e.user_id = u.id AND e.provider = 'entra') AS has_entra,
                ARRAY(SELECT r.role::text FROM user_roles r WHERE r.user_id = u.id ORDER BY r.role) AS roles
         FROM users u
         WHERE lower(u.email) = $1 OR lower(u.username) = $1
         ORDER BY u.id
         FOR UPDATE OF u`,
        [email],
      );
      if (matches.rows.length > 1) {
        throw new EntraSignInError("ambiguous", `${matches.rows.length} Talon users match ${email}`);
      }

      let userId;
      let outcome;
      if (matches.rows.length === 1) {
        const match = matches.rows[0];
        if (match.has_entra) {
          throw new EntraSignInError("already-linked", "the matching Talon user is linked to another Microsoft account");
        }
        if (match.status !== "active") {
          throw new EntraSignInError("disabled", "the matching Talon account is disabled");
        }
        if (!(match.roles.length === 1 && match.roles[0] === "student")) {
          throw new EntraSignInError(
            "link-by-admin",
            `the matching Talon user has roles [${match.roles.join(", ")}]; only students are linked automatically`,
          );
        }
        userId = match.id;
        outcome = "linked";
        // Matched by username only: record the address it was matched on.
        if (!match.email) {
          await client.query("UPDATE users SET email = $2 WHERE id = $1", [userId, email]);
        }
      } else {
        if (!autoCreate) {
          throw new EntraSignInError("no-account", `no Talon user for ${email}`);
        }
        const inserted = await client.query(
          "INSERT INTO users (username, email, display_name) VALUES ($1, $1, $2) RETURNING id",
          [email, name || email],
        );
        userId = inserted.rows[0].id;
        await setRoles(client, userId, ["student"], null);
        outcome = "created";
      }

      await client.query(
        `INSERT INTO user_identities (user_id, provider, subject, last_used_at)
         VALUES ($1, 'entra', $2, now())`,
        [userId, oid],
      );
      await client.query("UPDATE users SET last_login_at = now() WHERE id = $1", [userId]);
      return { userId, outcome };
    }, pool ? { pool } : undefined);
  } catch (error) {
    // Two first sign-ins at once (same person, two tabs; or two Microsoft
    // accounts with one address): the loser hits a unique index. Trying
    // again finds what the winner made (or refuses with already-linked).
    if (error?.code === "23505") {
      throw new EntraSignInError("retry", "a concurrent sign-in created this account; sign in again");
    }
    throw error;
  }
}
