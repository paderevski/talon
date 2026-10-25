-- Users, roles, sign-in identities, classes, budgets, sessions.
-- See docs/user-db-plan.md.

CREATE TYPE user_role AS ENUM ('student', 'teacher', 'admin');

CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username             text NOT NULL,   -- Entra users: full email; local/demo users: short handle
  email                text,            -- required for Entra users; null for demo accounts
  display_name         text NOT NULL,
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  storage_quota_bytes  bigint NOT NULL DEFAULT 10737418240 CHECK (storage_quota_bytes >= 0), -- 10 GB, per-user override
  storage_used_bytes   bigint NOT NULL DEFAULT 0 CHECK (storage_used_bytes >= 0),          -- updated after S3 syncs
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  last_login_at        timestamptz
);
CREATE UNIQUE INDEX users_username_key ON users (lower(username));
CREATE UNIQUE INDEX users_email_key    ON users (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE user_roles (
  user_id     uuid      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role        user_role NOT NULL,
  granted_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

-- How a user signs in. Only pre-provisioned users can sign in; Entra
-- identities are attached on first Entra login by matching email.
CREATE TABLE user_identities (
  id             bigserial PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider       text NOT NULL CHECK (provider IN ('local', 'entra')),
  subject        text NOT NULL,   -- local: lower(username); entra: tenant object ID (oid)
  password_hash  text,            -- local only; "salt:scrypt-hex"
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz,
  UNIQUE (provider, subject),
  CHECK ((provider = 'local') = (password_hash IS NOT NULL))
);
CREATE INDEX user_identities_user_idx ON user_identities (user_id);

CREATE TABLE classes (
  id           bigserial PRIMARY KEY,
  name         text NOT NULL,
  term         text,             -- e.g. '2026-27'
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE class_members (
  class_id     bigint NOT NULL REFERENCES classes (id) ON DELETE CASCADE,
  user_id      uuid   NOT NULL REFERENCES users (id)   ON DELETE CASCADE,
  member_role  text   NOT NULL CHECK (member_role IN ('teacher', 'student')),
  added_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (class_id, user_id)
);
CREATE INDEX class_members_user_idx ON class_members (user_id);

-- Every user has a 'personal' account (spent by their jobs); teachers also
-- have a 'teacher_pool' funded by an admin. Integer cents; shown as dollars.
CREATE TABLE budget_accounts (
  id             bigserial PRIMARY KEY,
  owner_user_id  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('personal', 'teacher_pool')),
  balance_cents  bigint NOT NULL DEFAULT 0,  -- cached SUM(ledger), updated in the same transaction
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, kind),
  CHECK (kind = 'personal' OR balance_cents >= 0)  -- pools can't be overdrawn
);

-- Append-only. A transfer is two rows sharing transfer_id (-X source, +X dest).
CREATE TABLE budget_ledger (
  id            bigserial PRIMARY KEY,
  account_id    bigint NOT NULL REFERENCES budget_accounts (id) ON DELETE CASCADE,
  amount_cents  bigint NOT NULL CHECK (amount_cents <> 0),
  kind          text NOT NULL CHECK (kind IN ('grant', 'transfer', 'charge', 'refund', 'adjustment')),
  transfer_id   uuid,
  job_id        text,            -- FK once jobs move to Postgres
  note          text,
  created_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX budget_ledger_account_idx  ON budget_ledger (account_id, created_at);
CREATE INDEX budget_ledger_transfer_idx ON budget_ledger (transfer_id) WHERE transfer_id IS NOT NULL;

-- connect-pg-simple's session table
CREATE TABLE sessions (
  sid     varchar PRIMARY KEY,
  sess    json NOT NULL,
  expire  timestamp(6) NOT NULL
);
CREATE INDEX sessions_expire_idx ON sessions (expire);
