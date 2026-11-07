import { getPool, withTransaction } from "../db/pool.js";
import { decryptSecret, encryptSecret } from "../utils/credentialCrypto.js";
import { log } from "../utils/log.js";

// Linked outside accounts (table connections), one row per user and
// provider. The provider's tokens are kept as one encrypted JSON value whose
// shape is the provider's business: { accessToken, refreshToken } for the
// OAuth providers so far. A store is bound to one provider and one
// encryption purpose; all functions take the Talon user id (users.id).

export class ConnectionInUseError extends Error {
  constructor(provider) {
    super(`That ${provider} account is already linked to another Talon user`);
    this.name = "ConnectionInUseError";
    this.provider = provider;
  }
}

const toDate = (value) => (value ? new Date(value) : null);

export function createConnectionsStore({ provider, tokenPurpose, pool, InUseError = ConnectionInUseError } = {}) {
  if (!/^[a-z][a-z0-9_]{1,31}$/.test(String(provider || "")) || !tokenPurpose) {
    throw new Error("A connections store needs a provider id and a token purpose");
  }
  const db = () => pool ?? getPool();

  const encryptTokens = (userId, tokens) => encryptSecret(JSON.stringify(tokens ?? {}), { purpose: tokenPurpose, ownerId: userId });

  // Returns null when the row cannot be decrypted (key lost or changed, row
  // tampered with or copied from another user): the caller treats the user
  // as not linked.
  function decryptRow(userId, row) {
    try {
      const tokens = JSON.parse(decryptSecret(
        { keyId: row.key_id, iv: row.iv, authTag: row.auth_tag, ciphertext: row.ciphertext },
        { purpose: tokenPurpose, ownerId: userId },
      ));
      return {
        ...tokens,
        accessExpiresAt: toDate(row.access_expires_at),
        refreshExpiresAt: toDate(row.refresh_expires_at),
        login: row.external_login,
      };
    } catch (error) {
      log.warn("cannot decrypt stored connection tokens", { event: "connection.token_decrypt_failed", provider, userId, error: error.message });
      return null;
    }
  }

  // { externalId, login, clientId, linkedAt } or null.
  async function getLink(userId) {
    if (!userId) {
      return null;
    }
    const { rows } = await db().query(
      "SELECT external_id, external_login, client_id, linked_at FROM connections WHERE user_id = $1 AND provider = $2",
      [userId, provider],
    );
    const row = rows[0];
    return row
      ? { externalId: row.external_id, login: row.external_login, clientId: row.client_id, linkedAt: row.linked_at.toISOString() }
      : null;
  }

  // Decrypted tokens plus { accessExpiresAt, refreshExpiresAt, login }, or null.
  async function getTokens(userId) {
    if (!userId) {
      return null;
    }
    const { rows } = await db().query("SELECT * FROM connections WHERE user_id = $1 AND provider = $2", [userId, provider]);
    return rows[0] ? decryptRow(userId, rows[0]) : null;
  }

  // tokens: provider token JSON plus optional accessExpiresAt/refreshExpiresAt
  // (stored in their own columns, not in the ciphertext).
  async function saveLink(userId, { externalId, login = "", clientId = null, tokens }) {
    if (!userId || !externalId || !tokens) {
      throw new Error("User, outside account and tokens are required");
    }
    const { accessExpiresAt = null, refreshExpiresAt = null, ...secret } = tokens;
    const encrypted = encryptTokens(userId, secret);
    try {
      await db().query(
        `INSERT INTO connections
           (user_id, provider, external_id, external_login, client_id, key_id, iv, auth_tag, ciphertext,
            access_expires_at, refresh_expires_at, linked_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), now())
         ON CONFLICT (user_id, provider) DO UPDATE SET
           external_id = EXCLUDED.external_id, external_login = EXCLUDED.external_login,
           client_id = EXCLUDED.client_id,
           key_id = EXCLUDED.key_id, iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag,
           ciphertext = EXCLUDED.ciphertext, access_expires_at = EXCLUDED.access_expires_at,
           refresh_expires_at = EXCLUDED.refresh_expires_at,
           linked_at = CASE WHEN connections.external_id = EXCLUDED.external_id
                            THEN connections.linked_at ELSE now() END,
           updated_at = now()`,
        [
          userId, provider, String(externalId), String(login), clientId,
          encrypted.keyId, encrypted.iv, encrypted.authTag, encrypted.ciphertext,
          accessExpiresAt, refreshExpiresAt,
        ],
      );
    } catch (error) {
      if (error?.code === "23505" && /connections_external_unique/.test(error?.constraint || "")) {
        throw new InUseError(provider);
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
      const { rows } = await client.query(
        "SELECT * FROM connections WHERE user_id = $1 AND provider = $2 FOR UPDATE",
        [userId, provider],
      );
      const tokens = rows[0] ? decryptRow(userId, rows[0]) : null;
      const save = async (next) => {
        const { accessExpiresAt = null, refreshExpiresAt = null, ...secret } = next;
        const encrypted = encryptTokens(userId, secret);
        await client.query(
          `UPDATE connections SET key_id = $3, iv = $4, auth_tag = $5, ciphertext = $6,
             access_expires_at = $7, refresh_expires_at = $8, updated_at = now()
           WHERE user_id = $1 AND provider = $2`,
          [userId, provider, encrypted.keyId, encrypted.iv, encrypted.authTag, encrypted.ciphertext, accessExpiresAt, refreshExpiresAt],
        );
      };
      return fn(tokens, save);
    }, { pool: db() });
  }

  async function deleteLink(userId) {
    if (userId) {
      await db().query("DELETE FROM connections WHERE user_id = $1 AND provider = $2", [userId, provider]);
    }
  }

  // Items the user chose to share (connection_items): [{ id, label, kind, addedAt }].
  async function listPicked(userId) {
    const { rows } = await db().query(
      `SELECT item_id, label, kind, added_at FROM connection_items
       WHERE user_id = $1 AND provider = $2 ORDER BY kind = 'folder' DESC, lower(label), item_id`,
      [userId, provider],
    );
    return rows.map((row) => ({ id: row.item_id, label: row.label, kind: row.kind, addedAt: row.added_at.toISOString() }));
  }

  // items: [{ id, label, kind }]; existing ones get the new label/kind.
  // Fails (foreign key) when the user has no link for this provider.
  async function addPicked(userId, items) {
    await withTransaction(async (client) => {
      for (const item of items) {
        await client.query(
          `INSERT INTO connection_items (user_id, provider, item_id, label, kind) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (user_id, provider, item_id) DO UPDATE SET label = EXCLUDED.label, kind = EXCLUDED.kind`,
          [userId, provider, item.id, item.label ?? "", item.kind ?? "file"],
        );
      }
    }, { pool: db() });
  }

  async function removePicked(userId, itemId) {
    const result = await db().query(
      "DELETE FROM connection_items WHERE user_id = $1 AND provider = $2 AND item_id = $3",
      [userId, provider, itemId],
    );
    return result.rowCount > 0;
  }

  async function countPicked(userId) {
    const { rows } = await db().query(
      "SELECT count(*)::int AS n FROM connection_items WHERE user_id = $1 AND provider = $2",
      [userId, provider],
    );
    return rows[0].n;
  }

  return { provider, getLink, getTokens, saveLink, withLockedTokens, deleteLink, listPicked, addPicked, removePicked, countPicked };
}
