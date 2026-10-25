import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

// Hash format: "<salt-hex>:<scrypt-64-byte-hex>"
export function createPasswordHash(
  password,
  salt = randomBytes(16).toString("hex"),
) {
  const normalizedPassword = String(password ?? "");
  const derivedKey = scryptSync(normalizedPassword, salt, 64).toString("hex");
  return `${salt}:${derivedKey}`;
}

export function verifyPassword(password, passwordHash) {
  const normalizedHash = String(passwordHash ?? "").trim();
  const [salt, storedHash] = normalizedHash.split(":");

  if (!salt || !storedHash) {
    return false;
  }

  const candidateHash = scryptSync(String(password ?? ""), salt, 64);
  const storedHashBuffer = Buffer.from(storedHash, "hex");

  if (candidateHash.length !== storedHashBuffer.length) {
    return false;
  }

  return timingSafeEqual(candidateHash, storedHashBuffer);
}

// Used when the username doesn't exist, so a miss costs the same scrypt work
// as a wrong password and response timing doesn't reveal valid usernames.
const dummyPasswordHash = createPasswordHash("talon-dummy-password");

export function burnPasswordCheck(password) {
  verifyPassword(password, dummyPasswordHash);
  return false;
}
