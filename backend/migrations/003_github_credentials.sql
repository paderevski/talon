-- Per-user GitHub personal access token, encrypted by the app (AES-256-GCM).
-- key_id says which key encrypted the row so keys can be rotated without
-- everyone re-entering tokens; the user id and key id are bound into the
-- ciphertext (GCM additional data) so a row copied to another user will not
-- decrypt. A row can exist with only github_username (no token yet).
CREATE TABLE github_credentials (
  user_id          uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  github_username  text NOT NULL DEFAULT '',
  key_id           text,
  iv               bytea,
  auth_tag         bytea,
  ciphertext       bytea,
  token_last4      text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT github_credentials_token_all_or_none CHECK (
    (key_id IS NULL AND iv IS NULL AND auth_tag IS NULL AND ciphertext IS NULL AND token_last4 IS NULL)
    OR
    (key_id IS NOT NULL AND iv IS NOT NULL AND auth_tag IS NOT NULL AND ciphertext IS NOT NULL AND token_last4 IS NOT NULL)
  )
);
