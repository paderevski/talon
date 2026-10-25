import { getPool } from "../db/pool.js";
import { decryptSecret, encryptSecret } from "./credentialCrypto.js";

const purpose = "github-token";

function cleanText(value) {
  return String(value ?? "").trim();
}

// All functions take the user's id (users.id), not the username.
export function createGithubCredentialsStore({ pool } = {}) {
  const db = () => pool ?? getPool();

  async function getRow(userId) {
    const result = await db().query(
      `SELECT github_username, key_id, iv, auth_tag, ciphertext, token_last4, updated_at
       FROM github_credentials WHERE user_id = $1`,
      [userId],
    );
    return result.rows[0] ?? null;
  }

  async function getGithubTokenStatusForUser(userId) {
    const row = userId ? await getRow(userId) : null;
    return {
      hasToken: Boolean(row?.ciphertext),
      tokenLast4: row?.token_last4 ?? "",
      githubUsername: cleanText(row?.github_username),
      updatedAt: row?.updated_at ? row.updated_at.toISOString() : null,
    };
  }

  // Decrypted token, or "" if none (or it cannot be decrypted: key lost or
  // changed, row tampered with). The caller then proceeds unauthenticated.
  async function getGithubTokenForUser(userId) {
    const row = userId ? await getRow(userId) : null;
    if (!row?.ciphertext) {
      return "";
    }

    try {
      return decryptSecret(
        { keyId: row.key_id, iv: row.iv, authTag: row.auth_tag, ciphertext: row.ciphertext },
        { purpose, ownerId: userId },
      );
    } catch (error) {
      console.warn(`[github-credentials] cannot decrypt token for user ${userId}: ${error.message}`);
      return "";
    }
  }

  async function saveGithubTokenForUser(userId, token, githubUsername = "") {
    const normalizedToken = cleanText(token);
    if (!userId || !normalizedToken) {
      throw new Error("User and token are required");
    }

    const encrypted = encryptSecret(normalizedToken, { purpose, ownerId: userId });
    await db().query(
      `INSERT INTO github_credentials
         (user_id, github_username, key_id, iv, auth_tag, ciphertext, token_last4, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (user_id) DO UPDATE SET
         github_username = EXCLUDED.github_username,
         key_id = EXCLUDED.key_id, iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag,
         ciphertext = EXCLUDED.ciphertext, token_last4 = EXCLUDED.token_last4,
         updated_at = now()`,
      [
        userId,
        cleanText(githubUsername),
        encrypted.keyId,
        encrypted.iv,
        encrypted.authTag,
        encrypted.ciphertext,
        normalizedToken.slice(-4),
      ],
    );
  }

  async function saveGithubUsernameForUser(userId, githubUsername) {
    if (!userId) {
      throw new Error("User is required");
    }

    const name = cleanText(githubUsername);
    if (!name) {
      await db().query("UPDATE github_credentials SET github_username = '' WHERE user_id = $1", [userId]);
      await db().query("DELETE FROM github_credentials WHERE user_id = $1 AND ciphertext IS NULL", [userId]);
      return;
    }

    await db().query(
      `INSERT INTO github_credentials (user_id, github_username) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET github_username = EXCLUDED.github_username`,
      [userId, name],
    );
  }

  async function deleteGithubTokenForUser(userId) {
    if (!userId) {
      return;
    }

    await db().query(
      `UPDATE github_credentials
       SET key_id = NULL, iv = NULL, auth_tag = NULL, ciphertext = NULL,
           token_last4 = NULL, updated_at = now()
       WHERE user_id = $1`,
      [userId],
    );
    await db().query(
      "DELETE FROM github_credentials WHERE user_id = $1 AND github_username = ''",
      [userId],
    );
  }

  return {
    getGithubTokenStatusForUser,
    getGithubTokenForUser,
    saveGithubTokenForUser,
    saveGithubUsernameForUser,
    deleteGithubTokenForUser,
  };
}

const defaultStore = createGithubCredentialsStore();

export const getGithubTokenStatusForUser = defaultStore.getGithubTokenStatusForUser;
export const getGithubTokenForUser = defaultStore.getGithubTokenForUser;
export const saveGithubTokenForUser = defaultStore.saveGithubTokenForUser;
export const saveGithubUsernameForUser = defaultStore.saveGithubUsernameForUser;
export const deleteGithubTokenForUser = defaultStore.deleteGithubTokenForUser;
