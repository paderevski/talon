// Git settings for cloning with a token (for GitHub, an installation token
// from services/githubApp.js). Git reads them as extra config from the
// environment, so the token is not in the clone URL, the process list, or
// the cloned repo's .git/config, and is sent only to `host`.
// No token: {} (anonymous clone).
const hostPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export function assertGitHost(host) {
  const value = String(host ?? "").trim().toLowerCase();
  if (!hostPattern.test(value)) {
    throw new Error(`Git host is invalid: ${String(host).slice(0, 60)}`);
  }
  return value;
}

export function gitAuthEnv(token, host = "github.com") {
  if (!token) {
    return {};
  }
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.https://${assertGitHost(host)}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

// Last line of git's error output, plus a hint when the host refused or hid
// the repo (a private repo cloned without access looks like this).
export function describeCloneError(stderr, { hint = "If the repository is private, connect GitHub in Talon and give the Talon app access to it." } = {}) {
  const text = String(stderr ?? "").trim();
  const last = text.split("\n").pop() || "git clone failed";
  if (/could not read Username|Authentication failed|Repository not found|terminal prompts disabled/i.test(text)) {
    return `${last}. ${hint}`;
  }
  return last;
}
