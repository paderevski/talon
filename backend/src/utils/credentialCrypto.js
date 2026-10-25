import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

// Encryption for secrets stored in the database (GitHub tokens).
//
//   TALON_CREDENTIALS_KEY       current key secret (required in production)
//   TALON_CREDENTIALS_KEY_ID    its id, stored with every encrypted value
//                               (default "k1")
//   TALON_CREDENTIALS_OLD_KEYS  retired keys still needed to decrypt old
//                               rows: "id:secret,id:secret"
//
// To rotate: set the new secret with a new KEY_ID, move the old one into
// OLD_KEYS, restart, run `npm run db:rotate-credentials-key`, then drop it
// from OLD_KEYS.
const keySalt = "talon-github-credentials";
const devFallbackSecret = "talon-dev-only-change-this-key";
const derivedKeys = new Map();

// Fail closed: the fallback is public in this repo, so a production server
// without a real key must not start (and must not "encrypt" with it).
if (process.env.NODE_ENV === "production" && !process.env.TALON_CREDENTIALS_KEY) {
  throw new Error(
    "TALON_CREDENTIALS_KEY is required when NODE_ENV=production (refusing to use the dev fallback key)",
  );
}

function deriveKey(secret) {
  if (!derivedKeys.has(secret)) {
    derivedKeys.set(secret, scryptSync(secret, keySalt, 32));
  }
  return derivedKeys.get(secret);
}

export function currentKeyId() {
  return String(process.env.TALON_CREDENTIALS_KEY_ID || "k1").trim();
}

function keyForId(keyId) {
  if (keyId === currentKeyId()) {
    return deriveKey(process.env.TALON_CREDENTIALS_KEY || devFallbackSecret);
  }

  for (const entry of String(process.env.TALON_CREDENTIALS_OLD_KEYS ?? "").split(",")) {
    const separator = entry.indexOf(":");
    if (separator > 0 && entry.slice(0, separator).trim() === keyId) {
      return deriveKey(entry.slice(separator + 1).trim());
    }
  }

  throw new Error(`No key available for key id '${keyId}'`);
}

function additionalData(purpose, ownerId, keyId) {
  return Buffer.from(`${purpose}|${ownerId}|${keyId}`, "utf8");
}

// Returns { keyId, iv, authTag, ciphertext } (Buffers).
export function encryptSecret(plaintext, { purpose, ownerId }) {
  const keyId = currentKeyId();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyForId(keyId), iv);
  cipher.setAAD(additionalData(purpose, ownerId, keyId));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { keyId, iv, authTag: cipher.getAuthTag(), ciphertext };
}

// Throws if the key is unknown, the data was tampered with, or the row
// belongs to a different owner.
export function decryptSecret({ keyId, iv, authTag, ciphertext }, { purpose, ownerId }) {
  const decipher = createDecipheriv("aes-256-gcm", keyForId(keyId), iv);
  decipher.setAAD(additionalData(purpose, ownerId, keyId));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

// Format used by the old githubCredentials.json file (no key id, no AAD),
// only for the one-time import.
export function decryptLegacyEntry(entry) {
  const iv = Buffer.from(String(entry?.iv ?? ""), "base64");
  const tag = Buffer.from(String(entry?.tag ?? ""), "base64");
  const data = Buffer.from(String(entry?.encryptedToken ?? ""), "base64");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveKey(process.env.TALON_CREDENTIALS_KEY || devFallbackSecret),
    iv,
  );
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
