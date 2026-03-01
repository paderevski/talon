import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const credentialsFilePath = path.resolve(
  __dirname,
  "../data/githubCredentials.json",
);

const encryptionSecret =
  process.env.TALON_CREDENTIALS_KEY || "talon-dev-only-change-this-key";
const encryptionSalt = "talon-github-credentials";
const encryptionKey = scryptSync(encryptionSecret, encryptionSalt, 32);

function normalizeTalonUsername(value) {
  return String(value ?? "").trim();
}

function encryptToken(token) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    encryptedToken: encrypted.toString("base64"),
  };
}

function decryptToken(entry) {
  const iv = Buffer.from(String(entry?.iv ?? ""), "base64");
  const tag = Buffer.from(String(entry?.tag ?? ""), "base64");
  const encryptedToken = Buffer.from(
    String(entry?.encryptedToken ?? ""),
    "base64",
  );

  if (!iv.length || !tag.length || !encryptedToken.length) {
    return "";
  }

  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(encryptedToken),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

async function loadStore() {
  try {
    const contents = await readFile(credentialsFilePath, "utf8");
    const parsed = JSON.parse(contents);
    if (!parsed || typeof parsed !== "object") {
      return { users: {} };
    }
    return {
      users:
        parsed.users && typeof parsed.users === "object" ? parsed.users : {},
    };
  } catch {
    return { users: {} };
  }
}

async function saveStore(store) {
  await writeFile(credentialsFilePath, JSON.stringify(store, null, 2), "utf8");
}

export async function getGithubTokenStatusForUser(talonUsername) {
  const normalizedUsername = normalizeTalonUsername(talonUsername);
  if (!normalizedUsername) {
    return { hasToken: false };
  }

  const store = await loadStore();
  const entry = store.users[normalizedUsername];

  if (!entry?.encryptedToken) {
    return { hasToken: false };
  }

  let tokenLast4 = "";
  try {
    const token = decryptToken(entry);
    tokenLast4 = token.slice(-4);
  } catch {
    tokenLast4 = "";
  }

  return {
    hasToken: true,
    tokenLast4,
    updatedAt: entry.updatedAt || null,
  };
}

export async function getGithubTokenForUser(talonUsername) {
  const normalizedUsername = normalizeTalonUsername(talonUsername);
  if (!normalizedUsername) {
    return "";
  }

  const store = await loadStore();
  const entry = store.users[normalizedUsername];
  if (!entry?.encryptedToken) {
    return "";
  }

  try {
    return decryptToken(entry);
  } catch {
    return "";
  }
}

export async function saveGithubTokenForUser(talonUsername, token) {
  const normalizedUsername = normalizeTalonUsername(talonUsername);
  const normalizedToken = String(token ?? "").trim();

  if (!normalizedUsername || !normalizedToken) {
    throw new Error("Username and token are required");
  }

  const store = await loadStore();
  const encrypted = encryptToken(normalizedToken);

  store.users[normalizedUsername] = {
    ...encrypted,
    updatedAt: new Date().toISOString(),
  };

  await saveStore(store);
}

export async function deleteGithubTokenForUser(talonUsername) {
  const normalizedUsername = normalizeTalonUsername(talonUsername);
  if (!normalizedUsername) {
    return;
  }

  const store = await loadStore();
  delete store.users[normalizedUsername];
  await saveStore(store);
}
