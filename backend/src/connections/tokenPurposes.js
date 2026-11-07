// Encryption purpose per connection provider. The purpose is bound into each
// row's ciphertext (GCM additional data), so it must never change for a
// provider; key rotation (scripts/db-rotate-credentials-key.mjs) uses this
// map to re-encrypt every provider's rows.
export const tokenPurposes = Object.freeze({
  github: "github-app-tokens",
  google_drive: "google-drive-tokens",
});
