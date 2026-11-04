-- GitHub App sign-in replaces personal access tokens. Stored PATs are
-- dropped (demo data only; older backups still contain them, encrypted).
--
-- One linked GitHub account per Talon user, and a GitHub account can be
-- linked to only one Talon user. The user's GitHub App tokens (access and
-- refresh) are kept together as one encrypted JSON value, using the same
-- scheme as before (AES-256-GCM, key id per row, user id bound into the
-- ciphertext). They let Talon act as that user, limited to the repositories
-- the app is installed on; clones use short-lived installation tokens instead.
DROP TABLE IF EXISTS github_credentials;

CREATE TABLE github_accounts (
  user_id             uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  github_user_id      bigint NOT NULL UNIQUE,
  github_login        text NOT NULL,
  key_id              text NOT NULL,
  iv                  bytea NOT NULL,
  auth_tag            bytea NOT NULL,
  ciphertext          bytea NOT NULL,
  -- NULL means the token does not expire (expiring user tokens turned off).
  access_expires_at   timestamptz,
  refresh_expires_at  timestamptz,
  linked_at           timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
