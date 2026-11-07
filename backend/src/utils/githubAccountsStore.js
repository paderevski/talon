import { ConnectionInUseError, createConnectionsStore } from "../connections/store.js";
import { tokenPurposes } from "../connections/tokenPurposes.js";

// The GitHub connection, in GitHub's terms (githubUserId, githubLogin): a
// thin layer over the generic connections store (provider 'github'). The
// user's GitHub App tokens are one encrypted JSON value:
// { accessToken, refreshToken }. All functions take the Talon user id.
export const tokenPurpose = tokenPurposes.github;

export class GithubAccountInUseError extends ConnectionInUseError {
  constructor() {
    super("github");
    this.message = "That GitHub account is already linked to another Talon user";
    this.name = "GithubAccountInUseError";
  }
}

export function createGithubAccountsStore({ pool } = {}) {
  const store = createConnectionsStore({ provider: "github", tokenPurpose, pool, InUseError: GithubAccountInUseError });

  const asGithubTokens = (tokens) => (tokens
    ? {
      accessToken: String(tokens.accessToken || ""),
      refreshToken: String(tokens.refreshToken || ""),
      accessExpiresAt: tokens.accessExpiresAt,
      refreshExpiresAt: tokens.refreshExpiresAt,
      githubLogin: tokens.login,
    }
    : null);

  const tokenJson = (tokens) => ({
    accessToken: String(tokens?.accessToken || ""),
    refreshToken: String(tokens?.refreshToken || ""),
    accessExpiresAt: tokens?.accessExpiresAt ?? null,
    refreshExpiresAt: tokens?.refreshExpiresAt ?? null,
  });

  async function getLink(userId) {
    const link = await store.getLink(userId);
    return link
      ? { githubUserId: Number(link.externalId), githubLogin: link.login, clientId: link.clientId, linkedAt: link.linkedAt }
      : null;
  }

  // { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt, githubLogin } or null.
  const getTokens = async (userId) => asGithubTokens(await store.getTokens(userId));

  // tokens: { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt }
  async function saveLink(userId, { githubUserId, githubLogin, clientId = null, tokens }) {
    if (!userId || !githubUserId || !githubLogin || !tokens?.accessToken) {
      throw new Error("User, GitHub account and token are required");
    }
    await store.saveLink(userId, { externalId: String(githubUserId), login: githubLogin, clientId, tokens: tokenJson(tokens) });
  }

  const withLockedTokens = (userId, fn) =>
    store.withLockedTokens(userId, (tokens, save) => fn(asGithubTokens(tokens), (next) => save(tokenJson(next))));

  return { getLink, getTokens, saveLink, withLockedTokens, deleteLink: store.deleteLink };
}

let defaultStore = null;
export const getGithubAccountsStore = () => (defaultStore ??= createGithubAccountsStore());
