// One-time import of the old githubCredentials.json file into Postgres,
// re-encrypting each token with the current key (and key id). The file is
// left in place; delete it yourself once you have checked the result.
//   npm run db:import-github-credentials --workspace backend -- [path/to/githubCredentials.json]
// Needs the same TALON_CREDENTIALS_KEY the file was written with.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, getPool } from "../src/db/pool.js";
import { decryptLegacyEntry } from "../src/utils/credentialCrypto.js";
import { createGithubCredentialsStore } from "../src/utils/githubCredentialsStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const filePath = path.resolve(
  process.argv[2] || path.join(__dirname, "../src/data/githubCredentials.json"),
);

try {
  const pool = getPool();
  const store = createGithubCredentialsStore({ pool });
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    console.log(`Nothing to import (${filePath}: ${error.code || error.message})`);
    process.exit(0);
  }

  let imported = 0;
  const skipped = [];
  for (const [username, entry] of Object.entries(parsed?.users ?? {})) {
    const found = await pool.query("SELECT id FROM users WHERE lower(username) = lower($1)", [username]);
    if (found.rowCount === 0) {
      skipped.push(`${username} (no such user)`);
      continue;
    }

    const userId = found.rows[0].id;
    const githubUsername = String(entry?.githubUsername ?? "");
    if (entry?.encryptedToken) {
      try {
        await store.saveGithubTokenForUser(userId, decryptLegacyEntry(entry), githubUsername);
        imported += 1;
      } catch {
        skipped.push(`${username} (token cannot be decrypted with the current key)`);
      }
    } else if (githubUsername) {
      await store.saveGithubUsernameForUser(userId, githubUsername);
      imported += 1;
    }
  }

  console.log(`Imported ${imported} entr${imported === 1 ? "y" : "ies"}; skipped ${skipped.length}`);
  skipped.forEach((line) => console.log(`  skipped: ${line}`));
} catch (error) {
  console.error(error?.message || String(error));
  process.exitCode = 1;
} finally {
  await closePool();
}
