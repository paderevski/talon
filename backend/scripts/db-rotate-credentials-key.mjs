// Re-encrypts every stored token that is not under the current key id.
// See src/utils/credentialCrypto.js for the rotation steps.
//   npm run db:rotate-credentials-key --workspace backend
import { closePool, getPool, withTransaction } from "../src/db/pool.js";
import { currentKeyId, decryptSecret, encryptSecret } from "../src/utils/credentialCrypto.js";

const purpose = "github-token";

try {
  const keyId = currentKeyId();
  const stale = await getPool().query(
    "SELECT user_id FROM github_credentials WHERE ciphertext IS NOT NULL AND key_id <> $1",
    [keyId],
  );

  let rotated = 0;
  const failed = [];
  for (const { user_id: userId } of stale.rows) {
    try {
      await withTransaction(async (client) => {
        const { rows } = await client.query(
          "SELECT key_id, iv, auth_tag, ciphertext FROM github_credentials WHERE user_id = $1 AND key_id <> $2 FOR UPDATE",
          [userId, keyId],
        );
        if (rows.length === 0) {
          return;
        }

        const row = rows[0];
        const token = decryptSecret(
          { keyId: row.key_id, iv: row.iv, authTag: row.auth_tag, ciphertext: row.ciphertext },
          { purpose, ownerId: userId },
        );
        const next = encryptSecret(token, { purpose, ownerId: userId });
        await client.query(
          "UPDATE github_credentials SET key_id = $2, iv = $3, auth_tag = $4, ciphertext = $5 WHERE user_id = $1",
          [userId, next.keyId, next.iv, next.authTag, next.ciphertext],
        );
        rotated += 1;
      });
    } catch (error) {
      failed.push(`${userId}: ${error.message}`);
    }
  }

  console.log(`Rotated ${rotated} token(s) to key id '${keyId}'; ${failed.length} failed`);
  failed.forEach((line) => console.log(`  failed: ${line}`));
  process.exitCode = failed.length ? 1 : 0;
} catch (error) {
  console.error(error?.message || String(error));
  process.exitCode = 1;
} finally {
  await closePool();
}
