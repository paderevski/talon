// Re-encrypts every stored connection token set (GitHub and any other
// provider in src/connections/tokenPurposes.js) that is not under the
// current key id. See src/utils/credentialCrypto.js for the rotation steps.
//   npm run db:rotate-credentials-key --workspace backend
import { closePool, getPool, withTransaction } from "../src/db/pool.js";
import { currentKeyId, decryptSecret, encryptSecret } from "../src/utils/credentialCrypto.js";
import { tokenPurposes } from "../src/connections/tokenPurposes.js";

try {
  const keyId = currentKeyId();
  const stale = await getPool().query("SELECT user_id, provider FROM connections WHERE key_id <> $1", [keyId]);

  let rotated = 0;
  const failed = [];
  for (const { user_id: userId, provider } of stale.rows) {
    try {
      const purpose = tokenPurposes[provider];
      if (!purpose) {
        throw new Error(`no token purpose for provider '${provider}'`);
      }
      await withTransaction(async (client) => {
        const { rows } = await client.query(
          "SELECT key_id, iv, auth_tag, ciphertext FROM connections WHERE user_id = $1 AND provider = $2 AND key_id <> $3 FOR UPDATE",
          [userId, provider, keyId],
        );
        if (rows.length === 0) {
          return;
        }

        const row = rows[0];
        const plaintext = decryptSecret(
          { keyId: row.key_id, iv: row.iv, authTag: row.auth_tag, ciphertext: row.ciphertext },
          { purpose, ownerId: userId },
        );
        const next = encryptSecret(plaintext, { purpose, ownerId: userId });
        await client.query(
          "UPDATE connections SET key_id = $3, iv = $4, auth_tag = $5, ciphertext = $6 WHERE user_id = $1 AND provider = $2",
          [userId, provider, next.keyId, next.iv, next.authTag, next.ciphertext],
        );
        rotated += 1;
      });
    } catch (error) {
      failed.push(`${userId} (${provider}): ${error.message}`);
    }
  }

  console.log(`Rotated ${rotated} connection token set(s) to key id '${keyId}'; ${failed.length} failed`);
  failed.forEach((line) => console.log(`  failed: ${line}`));
  process.exitCode = failed.length ? 1 : 0;
} catch (error) {
  console.error(error?.message || String(error));
  process.exitCode = 1;
} finally {
  await closePool();
}
