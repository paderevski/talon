import { createPrivateKey, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { splitRepoPath } from "talon-shared/repo";
import { getGithubAccountsStore } from "../utils/githubAccountsStore.js";
import { log } from "../utils/log.js";

// Talon's GitHub App (owned by the AET-CS org). Three kinds of credential:
//
//   user token          the student's own GitHub App token, from "Connect
//                       GitHub". It can only see repos the student can see AND
//                       the app is installed on, so it is the access check:
//                       repo list, repo browser, and "may this user run that
//                       private repo". Expires after 8 hours; refreshed with
//                       a single-use refresh token (valid about 6 months).
//   app JWT             signed with the app's private key, 10 minutes. Only
//                       used to find a repo's installation and mint the token
//                       below.
//   installation token  read-only, limited to the one repo being cloned, one
//                       hour. Used for `git clone` on the web server only; it
//                       never reaches the job instance.
//
// Public repos need none of this: they are cloned anonymously.
//
// Settings, from the environment first (local dev), else SSM under
// TALON_SSM_PREFIX (production):
//   GITHUB_APP_CLIENT_ID       github-app-client-id       (String, Terraform)
//   GITHUB_APP_SLUG            github-app-slug            (String, Terraform)
//   TALON_PUBLIC_URL           public-url                 (String, Terraform)
//   GITHUB_APP_CLIENT_SECRET   github-app-client-secret   (SecureString, by hand)
//   GITHUB_APP_PRIVATE_KEY     github-app-private-key     (SecureString, by hand)
//     (or GITHUB_APP_PRIVATE_KEY_FILE: path to the .pem, dev only)
// Without them the feature is off: public repos still work.

const apiBase = "https://api.github.com";
const webBase = "https://github.com";
const ssmPrefix = () => process.env.TALON_SSM_PREFIX || "/talon/demo";
const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const unconfiguredRetryMs = 60 * 1000;
const refreshMarginMs = 5 * 60 * 1000;

const ssmNames = {
  clientId: "github-app-client-id",
  slug: "github-app-slug",
  publicUrl: "public-url",
  clientSecret: "github-app-client-secret",
  privateKey: "github-app-private-key",
};

export function httpError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  if (code) {
    error.code = code;
  }
  return error;
}

const base64url = (value) => Buffer.from(value).toString("base64url");

// RS256 JWT for authenticating as the app (GitHub: iss = client id, at most
// 10 minutes; iat is backdated a minute for clock drift).
export function createAppJwt({ clientId, privateKey }, nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: clientId }),
  )}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

function tokensFromGrant(grant, nowMs) {
  const at = (seconds) => (Number(seconds) > 0 ? new Date(nowMs + Number(seconds) * 1000) : null);
  return {
    accessToken: grant.access_token,
    refreshToken: grant.refresh_token || "",
    accessExpiresAt: at(grant.expires_in),
    refreshExpiresAt: at(grant.refresh_token_expires_in),
  };
}

function readEnvConfig(env) {
  let privateKey = String(env.GITHUB_APP_PRIVATE_KEY || "").replace(/\\n/g, "\n").trim();
  if (!privateKey && env.GITHUB_APP_PRIVATE_KEY_FILE) {
    privateKey = readFileSync(env.GITHUB_APP_PRIVATE_KEY_FILE, "utf8").trim();
  }
  return {
    clientId: String(env.GITHUB_APP_CLIENT_ID || "").trim(),
    slug: String(env.GITHUB_APP_SLUG || "").trim(),
    publicUrl: String(env.TALON_PUBLIC_URL || "").trim(),
    clientSecret: String(env.GITHUB_APP_CLIENT_SECRET || "").trim(),
    privateKey,
  };
}

// Accepts the slug or the app's page URL (https://github.com/apps/<slug>).
export const normalizeSlug = (value) =>
  String(value || "").trim().replace(/^https?:\/\/github\.com\/apps\//i, "").replace(/[/?#].*$/, "");

const isComplete = (c) => Boolean(c.clientId && c.slug && c.clientSecret && c.privateKey);

export function createGithubApp({
  config = null, // full settings object; default: environment, then SSM
  env = process.env,
  ssm = null,
  store = null,
  fetch: fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  const accounts = () => store ?? getGithubAccountsStore();
  let cached = null; // { value, at }

  async function loadConfig() {
    if (config) {
      return config;
    }
    let resolved = readEnvConfig(env);
    if (!isComplete(resolved) && env.NODE_ENV === "production") {
      const client = ssm ?? new SSMClient({ region });
      const names = Object.values(ssmNames).map((n) => `${ssmPrefix()}/${n}`);
      const result = await client.send(new GetParametersCommand({ Names: names, WithDecryption: true }));
      const value = (key) => result.Parameters?.find((p) => p.Name === `${ssmPrefix()}/${ssmNames[key]}`)?.Value?.trim() || "";
      resolved = Object.fromEntries(Object.keys(ssmNames).map((key) => [key, resolved[key] || value(key)]));
    }
    if (!isComplete(resolved)) {
      return null;
    }
    return {
      ...resolved,
      slug: normalizeSlug(resolved.slug),
      publicUrl: (resolved.publicUrl || "http://localhost:5173").replace(/\/+$/, ""),
      privateKey: createPrivateKey(resolved.privateKey),
    };
  }

  // Settings, or null when the app is not configured. Retried after a minute
  // when missing or unreadable, so adding the SSM parameters needs no restart.
  async function getConfig() {
    if (cached && (cached.value || now() - cached.at < unconfiguredRetryMs)) {
      return cached.value;
    }
    let value = null;
    try {
      value = await loadConfig();
    } catch (error) {
      log.warn("cannot load GitHub App settings", { event: "github.settings_failed", error: error.message });
    }
    cached = { value, at: now() };
    return value;
  }

  async function requireConfig() {
    const cfg = await getConfig();
    if (!cfg) {
      throw httpError("GitHub sign-in is not set up on this server", 503, "not-configured");
    }
    return cfg;
  }

  async function github(path, { token, jwt, method = "GET", body } = {}) {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "talon-portal",
    };
    if (token || jwt) {
      headers.Authorization = `Bearer ${token || jwt}`;
    }
    if (body) {
      headers["Content-Type"] = "application/json";
    }
    const response = await fetchImpl(`${apiBase}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    return { status: response.status, ok: response.ok, data };
  }

  // POST to GitHub's OAuth token endpoint. GitHub answers 200 with an
  // `error` field on failure.
  async function tokenRequest(cfg, params) {
    const response = await fetchImpl(`${webBase}/login/oauth/access_token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "talon-portal" },
      body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...params }).toString(),
    });
    const data = await response.json().catch(() => ({}));
    if (data.error === "incorrect_client_credentials") {
      // Wrong client id or secret: re-read the settings next time, so a
      // corrected SSM value works without a restart.
      log.warn("GitHub rejected the app's client credentials; reloading settings next time", { event: "github.bad_client" });
      cached = null;
    }
    if (!response.ok || data.error || !data.access_token) {
      throw httpError(`GitHub token request failed: ${data.error || response.status}`, 502, data.error || "token-failed");
    }
    return data;
  }

  async function status() {
    return { configured: Boolean(await getConfig()) };
  }

  // Where "Connect GitHub" sends the browser. mode "install" opens the app's
  // install page (pick an account and repositories); with "Request user
  // authorization during installation" on, GitHub then comes back to the
  // callback with a code as well. mode "authorize" only signs the user in.
  async function authorizeUrl(state, mode = "authorize") {
    const cfg = await requireConfig();
    if (mode === "install") {
      return `${webBase}/apps/${encodeURIComponent(cfg.slug)}/installations/new?state=${encodeURIComponent(state)}`;
    }
    // prompt=select_account: GitHub shows its account picker instead of
    // silently using whoever is signed in to github.com in this browser
    // (students with a personal and a school account; borrowed computers).
    const params = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: callbackUrl(cfg), state, prompt: "select_account" });
    return `${webBase}/login/oauth/authorize?${params}`;
  }

  const callbackUrl = (cfg) => `${cfg.publicUrl}/api/github/callback`;

  // Exchanges the callback code and links the GitHub account to the user.
  async function completeLink(userId, code) {
    const cfg = await requireConfig();
    const grant = await tokenRequest(cfg, { code, redirect_uri: callbackUrl(cfg) });
    const tokens = tokensFromGrant(grant, now());
    const me = await github("/user", { token: tokens.accessToken });
    if (!me.ok || !me.data?.id || !me.data?.login) {
      throw httpError(`Could not read the GitHub account (${me.status})`, 502);
    }
    await accounts().saveLink(userId, { githubUserId: me.data.id, githubLogin: me.data.login, clientId: cfg.clientId, tokens });
    return { githubLogin: me.data.login };
  }

  // The user's access token, refreshed when it is about to expire; null when
  // the app is not configured or the user is not linked (or must reconnect).
  async function getUserAccessToken(userId) {
    if (!userId || !(await getConfig())) {
      return null;
    }
    const current = await accounts().getTokens(userId);
    if (!current) {
      return null;
    }
    const fresh = (t) => !t.accessExpiresAt || t.accessExpiresAt.getTime() - now() > refreshMarginMs;
    if (fresh(current)) {
      return current.accessToken;
    }

    const cfg = await requireConfig();
    let unlink = false;
    const token = await accounts().withLockedTokens(userId, async (locked, save) => {
      if (!locked) {
        return null;
      }
      if (fresh(locked)) {
        return locked.accessToken; // another request refreshed it meanwhile
      }
      if (!locked.refreshToken || (locked.refreshExpiresAt && locked.refreshExpiresAt.getTime() <= now())) {
        unlink = true;
        return null;
      }
      try {
        const next = tokensFromGrant(await tokenRequest(cfg, { grant_type: "refresh_token", refresh_token: locked.refreshToken }), now());
        await save(next);
        return next.accessToken;
      } catch (error) {
        // Revoked or already used: the user has to connect again. Anything
        // else (GitHub down) leaves the link alone.
        if (error.code === "bad_refresh_token") {
          unlink = true;
          return null;
        }
        throw error;
      }
    });
    if (unlink) {
      await accounts().deleteLink(userId);
    }
    return token;
  }

  // GitHub answered 401 to the user's token: it was revoked (the student or
  // another Talon server disconnected, or the app was uninstalled). Forget the
  // link so the GitHub panel offers Connect again.
  async function forgetRevokedLink(userId) {
    log.warn("GitHub rejected the stored token; unlinking", { event: "github.token_rejected", userId });
    await accounts().deleteLink(userId);
  }

  // Repositories the user can pick: every repo on every installation the
  // user can see. [{ fullName, private }]
  async function listRepos(userId) {
    await requireConfig();
    const token = await getUserAccessToken(userId);
    if (!token) {
      throw httpError("Connect GitHub first", 409, "not-linked");
    }
    const installations = await github("/user/installations?per_page=100", { token });
    if (installations.status === 401) {
      await forgetRevokedLink(userId);
      throw httpError("GitHub access was revoked. Connect GitHub again.", 409, "not-linked");
    }
    if (!installations.ok) {
      throw httpError(`Could not list GitHub installations (${installations.status})`, 502);
    }
    const repos = new Map();
    for (const installation of installations.data?.installations ?? []) {
      for (let page = 1; page <= 10; page += 1) {
        const result = await github(`/user/installations/${installation.id}/repositories?per_page=100&page=${page}`, { token });
        if (!result.ok) {
          break;
        }
        const items = result.data?.repositories ?? [];
        items.forEach((r) => repos.set(r.full_name, { fullName: r.full_name, private: Boolean(r.private) }));
        if (items.length < 100) {
          break;
        }
      }
    }
    return [...repos.values()].sort((a, b) => a.fullName.localeCompare(b.fullName, undefined, { sensitivity: "base" }));
  }

  // Before a job starts: the token to clone `repo` with, or null to clone
  // anonymously. Private repos must be visible to the user's own token (the
  // access check), then get a read-only installation token for that one repo.
  async function resolveCloneToken(userId, repo) {
    const parts = splitRepoPath(repo);
    if (!parts) {
      throw httpError("Invalid repository format. Expected owner/repo", 400);
    }
    const userToken = await getUserAccessToken(userId);
    if (!userToken) {
      return null; // not set up or not linked: public repos only
    }
    const repoPath = `/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}`;
    const info = await github(repoPath, { token: userToken });
    if (info.status === 401) {
      await forgetRevokedLink(userId);
      return null; // public repos still clone anonymously
    }
    if (info.status === 404) {
      throw httpError(
        `Repository ${parts.path} was not found, or the Talon GitHub app has no access to it. Use "Choose repositories" in the GitHub panel to add it.`,
        400,
      );
    }
    if (!info.ok) {
      throw httpError(`Could not check ${parts.path} on GitHub (${info.status})`, 502);
    }
    if (!info.data?.private) {
      return null;
    }

    const cfg = await requireConfig();
    const jwt = createAppJwt(cfg, now());
    const installation = await github(`${repoPath}/installation`, { jwt });
    if (!installation.ok || !installation.data?.id) {
      throw httpError(`The Talon GitHub app is not installed on ${parts.path}`, 400);
    }
    const minted = await github(`/app/installations/${installation.data.id}/access_tokens`, {
      jwt,
      method: "POST",
      body: { repositories: [parts.repo], permissions: { contents: "read" } },
    });
    if (!minted.ok || !minted.data?.token) {
      throw httpError(`Could not get access to ${parts.path} (${minted.status})`, 502);
    }
    return minted.data.token;
  }

  // Unlinks the user and, best effort, revokes Talon's grant on GitHub (the
  // app stays installed; the student can uninstall it in GitHub settings).
  async function unlink(userId) {
    const cfg = await getConfig();
    const tokens = await accounts().getTokens(userId);
    if (cfg && tokens?.accessToken) {
      try {
        const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
        await fetchImpl(`${apiBase}/applications/${encodeURIComponent(cfg.clientId)}/grant`, {
          method: "DELETE",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Basic ${basic}`,
            "Content-Type": "application/json",
            "User-Agent": "talon-portal",
          },
          body: JSON.stringify({ access_token: tokens.accessToken }),
        });
      } catch (error) {
        log.warn("could not revoke the GitHub grant", { event: "github.revoke_failed", userId, error: error.message });
      }
    }
    await accounts().deleteLink(userId);
  }

  return {
    status,
    getConfig,
    authorizeUrl,
    completeLink,
    getUserAccessToken,
    listRepos,
    resolveCloneToken,
    unlink,
    forgetRevokedLink,
    getLink: (userId) => accounts().getLink(userId),
  };
}

let defaultApp = null;
export const getGithubApp = () => (defaultApp ??= createGithubApp());
