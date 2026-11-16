import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

// Async so a login runs scrypt on the libuv thread pool instead of blocking
// the event loop. Same parameters as the old scryptSync calls (the defaults),
// so every stored hash still verifies.
const scryptAsync = promisify(scrypt);

// Hash format: "<salt-hex>:<scrypt-64-byte-hex>"
export async function createPasswordHash(
  password,
  salt = randomBytes(16).toString("hex"),
) {
  const normalizedPassword = String(password ?? "");
  const derivedKey = (await scryptAsync(normalizedPassword, salt, 64)).toString("hex");
  return `${salt}:${derivedKey}`;
}

export async function verifyPassword(password, passwordHash) {
  const normalizedHash = String(passwordHash ?? "").trim();
  const [salt, storedHash] = normalizedHash.split(":");

  if (!salt || !storedHash) {
    return false;
  }

  const candidateHash = await scryptAsync(String(password ?? ""), salt, 64);
  const storedHashBuffer = Buffer.from(storedHash, "hex");

  if (candidateHash.length !== storedHashBuffer.length) {
    return false;
  }

  return timingSafeEqual(candidateHash, storedHashBuffer);
}

// Used when the username doesn't exist, so a miss costs the same scrypt work
// as a wrong password and response timing doesn't reveal valid usernames.
const dummyPasswordHash = await createPasswordHash("talon-dummy-password");

export async function burnPasswordCheck(password) {
  await verifyPassword(password, dummyPasswordHash);
  return false;
}
