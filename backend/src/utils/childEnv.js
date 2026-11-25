// What a subprocess (git, tar, a local job's script) may see of the server's
// environment. Never the whole of process.env: it holds the session secret,
// the database URL and the credentials key, and git runs against
// student-chosen repositories. AWS_EC2_METADATA_DISABLED keeps AWS SDKs and
// the CLI from picking up the instance role (it does not stop a raw request
// to the metadata service).
const passThroughEnv = [
  "PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TZ", "SYSTEMROOT",
  // Outbound proxy and CA settings, if a host ever needs them.
  "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "GIT_SSL_CAINFO",
];

export function childEnv(extra = {}, source = process.env) {
  const env = { AWS_EC2_METADATA_DISABLED: "true" };
  for (const name of passThroughEnv) {
    if (source[name] !== undefined) {
      env[name] = source[name];
    }
  }
  return { ...env, ...extra };
}
