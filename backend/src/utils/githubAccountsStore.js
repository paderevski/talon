import { getPool, withTransaction } from "../db/pool.js";
import { decryptSecret, encryptSecret } from "./credentialCrypto.js";
import { log } from "./log.js";

// Linked GitHub accounts (table github_accounts). The user's GitHub App
// tokens are stored as one encrypted JSON value: { accessToken, refreshToken }.
// All functions take the Talon user id (users.id).
export const tokenPurpose = "github-app-tokens";

export class GithubAccountInUseError extends Error {
  constructor() {
    super("That GitHub account is already linked to another Talon user");
    this.name = "GithubAccountInUseError";
  }
}

const toDate = (value) => (value ? new Date(value) : null);

function encryptTokens(userId, { accessToken, refreshToken }) {
  return encryptSecret(
    JSON.stringify({ accessToken: String(accessToken || ""), refreshToken: String(refreshToken || "") }),
    { purpose: tokenPurpose, ownerId: userId },
  );
}

// Returns null when the row cannot be decrypted (key lost or changed, row
// tampered with or copied from another user): the caller treats the user as
// not linked.
function decryptRow(userId, row) {
  try {
    const tokens = JSON.parse(decryptSecret(
      { keyId: row.key_id, iv: row.iv, authTag: row.auth_tag, ciphertext: row.ciphertext },
      { purpose: tokenPurpose, ownerId: userId },
    ));
    return {
      accessToken: String(tokens.accessToken || ""),
      refreshToken: String(tokens.refreshToken || ""),
      accessExpiresAt: toDate(row.access_expires_at),
      refreshExpiresAt: toDate(row.refresh_expires_at),
      githubLogin: row.github_login,
    };
  } catch (error) {
    log.warn("cannot decrypt stored GitHub tokens", { event: "github.token_decrypt_failed", userId, error: error.message });
    return null;
  }
}

export function createGithubAccountsStore({ pool } = {}) {
  const db = () => pool ?? getPool();

  async function getLink(userId) {
    if (!userId) {
      return null;
    }
    const { rows } = await db().query(
      "SELECT github_user_id, github_login, linked_at FROM github_accounts WHERE user_id = $1",
      [userId],
    );
    const row = rows[0];
    return row
      ? { githubUserId: Number(row.github_user_id), githubLogin: row.github_login, linkedAt: row.linked_at.toISOString() }
      : null;
  }

  // { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt, githubLogin } or null.
  async function getTokens(userId) {
    if (!userId) {
      return null;
    }
    const { rows } = await db().query("SELECT * FROM github_accounts WHERE user_id = $1", [userId]);
    return rows[0] ? decryptRow(userId, rows[0]) : null;
  }

  // tokens: { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt }
  async function saveLink(userId, { githubUserId, githubLogin, tokens }) {
    if (!userId || !githubUserId || !githubLogin || !tokens?.accessToken) {
      throw new Error("User, GitHub account and token are required");
    }
    const encrypted = encryptTokens(userId, tokens);
    try {
      await db().query(
        `INSERT INTO github_accounts
           (user_id, github_user_id, github_login, key_id, iv, auth_tag, ciphertext,
            access_expires_at, refresh_expires_at, linked_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())
         ON CONFLICT (user_id) DO UPDATE SET
           github_user_id = EXCLUDED.github_user_id, github_login = EXCLUDED.github_login,
           key_id = EXCLUDED.key_id, iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag,
           ciphertext = EXCLUDED.ciphertext, access_expires_at = EXCLUDED.access_expires_at,
           refresh_expires_at = EXCLUDED.refresh_expires_at,
           linked_at = CASE WHEN github_accounts.github_user_id = EXCLUDED.github_user_id
                            THEN github_accounts.linked_at ELSE now() END,
           updated_at = now()`,
        [
          userId, githubUserId, githubLogin,
          encrypted.keyId, encrypted.iv, encrypted.authTag, encrypted.ciphertext,
          tokens.accessExpiresAt ?? null, tokens.refreshExpiresAt ?? null,
        ],
      );
    } catch (error) {
      if (error?.code === "23505" && /github_user_id/.test(error?.constraint || error?.detail || "")) {
        throw new GithubAccountInUseError();
      }
      throw error;
    }
  }

  // Runs fn(tokens, save) with the user's row locked, so two requests cannot
  // both spend the same single-use refresh token. tokens is null when the
  // user is not linked (or the row cannot be decrypted); save(newTokens)
  // stores refreshed tokens; fn's return value is returned.
  async function withLockedTokens(userId, fn) {
    return withTransaction(async (client) => {
      const { rows } = await client.query("SELECT * FROM github_accounts WHERE user_id = $1 FOR UPDATE", [userId]);
      const tokens = rows[0] ? decryptRow(userId, rows[0]) : null;
      const save = async (next) => {
        const encrypted = encryptTokens(userId, next);
        await client.query(
          `UPDATE github_accounts SET key_id = $2, iv = $3, auth_tag = $4, ciphertext = $5,
             access_expires_at = $6, refresh_expires_at = $7, updated_at = now()
           WHERE user_id = $1`,
          [userId, encrypted.keyId, encrypted.iv, encrypted.authTag, encrypted.ciphertext,
            next.accessExpiresAt ?? null, next.refreshExpiresAt ?? null],
        );
      };
      return fn(tokens, save);
    }, { pool: db() });
  }

  async function deleteLink(userId) {
    if (userId) {
      await db().query("DELETE FROM github_accounts WHERE user_id = $1", [userId]);
    }
  }

  return { getLink, getTokens, saveLink, withLockedTokens, deleteLink };
}

let defaultStore = null;
export const getGithubAccountsStore = () => (defaultStore ??= createGithubAccountsStore());
