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
const usingDefaultEncryptionSecret = !process.env.TALON_CREDENTIALS_KEY;

console.info(
  `[github-credentials] encryption key source: ${usingDefaultEncryptionSecret ? "default-fallback" : "env:TALON_CREDENTIALS_KEY"}`,
);

function normalizeTalonUsername(value) {
  return String(value ?? "").trim();
}

function normalizeGithubUsername(value) {
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
  console.info(
    `[github-credentials] loading credential store from ${credentialsFilePath}`,
  );
  try {
    const contents = await readFile(credentialsFilePath, "utf8");
    const parsed = JSON.parse(contents);
    if (!parsed || typeof parsed !== "object") {
      console.warn("[github-credentials] store file parsed to non-object; using empty store");
      return { users: {} };
    }
    const normalized = {
      users:
        parsed.users && typeof parsed.users === "object" ? parsed.users : {},
    };
    console.info(
      `[github-credentials] store loaded; users=${Object.keys(normalized.users).length}`,
    );
    return normalized;
  } catch {
    console.warn("[github-credentials] store unavailable or unreadable; using empty store");
    return { users: {} };
  }
}

async function saveStore(store) {
  await writeFile(credentialsFilePath, JSON.stringify(store, null, 2), "utf8");
}

export async function getGithubTokenStatusForUser(talonUsername) {
  const normalizedUsername = normalizeTalonUsername(talonUsername);
  console.info(
    `[github-credentials] status requested for talon user='${normalizedUsername || "(missing)"}'`,
  );
  if (!normalizedUsername) {
    return { hasToken: false, githubUsername: "" };
  }

  const store = await loadStore();
  const entry = store.users[normalizedUsername];

  if (!entry?.encryptedToken) {
    console.info(
      `[github-credentials] no token entry found for talon user='${normalizedUsername}'`,
    );
    return {
      hasToken: false,
      githubUsername: normalizeGithubUsername(entry?.githubUsername),
      updatedAt: entry?.updatedAt || null,
    };
  }

  let tokenLast4 = "";
  try {
    console.info(
      `[github-credentials] decrypting token for talon user='${normalizedUsername}' (status check)`,
    );
    const token = decryptToken(entry);
    tokenLast4 = token.slice(-4);
    console.info(
      `[github-credentials] decrypt success for talon user='${normalizedUsername}'`,
    );
  } catch {
    console.warn(
      `[github-credentials] decrypt failed for talon user='${normalizedUsername}'`,
    );
    tokenLast4 = "";
  }

  return {
    hasToken: true,
    tokenLast4,
    githubUsername: normalizeGithubUsername(entry?.githubUsername),
    updatedAt: entry.updatedAt || null,
  };
}

export async function getGithubTokenForUser(talonUsername) {
  const normalizedUsername = normalizeTalonUsername(talonUsername);
  console.info(
    `[github-credentials] token requested for talon user='${normalizedUsername || "(missing)"}'`,
  );
  if (!normalizedUsername) {
    return "";
  }

  const store = await loadStore();
  const entry = store.users[normalizedUsername];
  if (!entry?.encryptedToken) {
    console.info(
      `[github-credentials] token entry missing for talon user='${normalizedUsername}'`,
    );
    return "";
  }

  try {
    console.info(
      `[github-credentials] decrypting token for talon user='${normalizedUsername}' (token fetch)`,
    );
    return decryptToken(entry);
  } catch {
    console.warn(
      `[github-credentials] decrypt failed for talon user='${normalizedUsername}' (token fetch)`,
    );
    return "";
  }
}

export async function saveGithubTokenForUser(talonUsername, token, githubUsername = "") {
  const normalizedUsername = normalizeTalonUsername(talonUsername);
  const normalizedToken = String(token ?? "").trim();
  const normalizedGithubUsername = normalizeGithubUsername(githubUsername);

  console.info(
    `[github-credentials] save requested for talon user='${normalizedUsername || "(missing)"}'`,
  );

  if (!normalizedUsername || !normalizedToken) {
    throw new Error("Username and token are required");
  }

  const store = await loadStore();
  const encrypted = encryptToken(normalizedToken);
  const existingEntry = store.users[normalizedUsername] || {};

  store.users[normalizedUsername] = {
    ...existingEntry,
    ...encrypted,
    githubUsername: normalizedGithubUsername,
    updatedAt: new Date().toISOString(),
  };

  await saveStore(store);
}

export async function saveGithubUsernameForUser(talonUsername, githubUsername) {
  const normalizedUsername = normalizeTalonUsername(talonUsername);
  const normalizedGithubUsername = normalizeGithubUsername(githubUsername);

  console.info(
    `[github-credentials] github username save requested for talon user='${normalizedUsername || "(missing)"}'`,
  );

  if (!normalizedUsername) {
    throw new Error("Username is required");
  }

  const store = await loadStore();
  const existingEntry = store.users[normalizedUsername] || {};

  if (!normalizedGithubUsername && !existingEntry.encryptedToken) {
    delete store.users[normalizedUsername];
    await saveStore(store);
    return;
  }

  store.users[normalizedUsername] = {
    ...existingEntry,
    githubUsername: normalizedGithubUsername,
    updatedAt: new Date().toISOString(),
  };

  await saveStore(store);
}

export async function deleteGithubTokenForUser(talonUsername) {
  const normalizedUsername = normalizeTalonUsername(talonUsername);
  console.info(
    `[github-credentials] delete requested for talon user='${normalizedUsername || "(missing)"}'`,
  );
  if (!normalizedUsername) {
    return;
  }

  const store = await loadStore();
  const existingEntry = store.users[normalizedUsername];
  if (!existingEntry) {
    return;
  }

  const githubUsername = normalizeGithubUsername(existingEntry.githubUsername);
  if (!githubUsername) {
    delete store.users[normalizedUsername];
    await saveStore(store);
    return;
  }

  store.users[normalizedUsername] = {
    githubUsername,
    updatedAt: new Date().toISOString(),
  };
  await saveStore(store);
}
