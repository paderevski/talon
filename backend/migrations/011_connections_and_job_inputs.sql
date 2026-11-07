-- Connections and sources (plan: docs/connections-and-sources-plan.md).
--
-- 1. connections: outside accounts a user has linked, one row per user and
--    provider. Replaces github_accounts; existing GitHub links are copied
--    and still decrypt (the encryption binds purpose and user id, not table).
-- 2. job_inputs: what a job runs from. Exactly one 'code' input per job
--    today; 'data' inputs (home folders, datasets) can be added later. The
--    git fields (repo, branch) move off jobs into the code input's ref, and
--    the input records the snapshot the job actually ran (S3 key, sha256,
--    size, commit for git).
-- 3. jobs.source_label / results.source_label: what lists show
--    ("owner/repo", later "Drive: Lab 3", "mnist.zip").

-- 1. connections -----------------------------------------------------------

CREATE TABLE connections (
  user_id             uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider            text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  -- The account's id on the provider (GitHub numeric id, Google "sub").
  external_id         text NOT NULL,
  -- What to show: GitHub login, Google email.
  external_login      text NOT NULL DEFAULT '',
  -- OAuth client that issued the tokens. When the server's client changes
  -- (e.g. moving the Google project), older links are known to need a
  -- reconnect. NULL: unknown (links made before this column).
  client_id           text,
  -- Provider tokens as one encrypted JSON value (AES-256-GCM, key id per
  -- row, user id and purpose bound into the ciphertext).
  key_id              text NOT NULL,
  iv                  bytea NOT NULL,
  auth_tag            bytea NOT NULL,
  ciphertext          bytea NOT NULL,
  access_expires_at   timestamptz,
  refresh_expires_at  timestamptz,
  linked_at           timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider),
  -- An outside account can be linked to only one Talon user.
  CONSTRAINT connections_external_unique UNIQUE (provider, external_id)
);

INSERT INTO connections
  (user_id, provider, external_id, external_login, key_id, iv, auth_tag, ciphertext,
   access_expires_at, refresh_expires_at, linked_at, updated_at)
SELECT user_id, 'github', github_user_id::text, github_login, key_id, iv, auth_tag, ciphertext,
       access_expires_at, refresh_expires_at, linked_at, updated_at
FROM github_accounts;

DROP TABLE github_accounts;

-- 2. job_inputs ------------------------------------------------------------

CREATE TABLE job_inputs (
  id               bigserial PRIMARY KEY,
  job_id           text NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('code', 'data')),
  -- Registered source type (backend/src/sources): 'github' today.
  source_type      text NOT NULL CHECK (source_type ~ '^[a-z][a-z0-9_]{1,31}$'),
  -- Per type. github: { host, repo, branch, commit }.
  source_ref       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Where a data input appears in the job ('' for the code input).
  mount_path       text NOT NULL DEFAULT '',
  -- The packed copy the job ran from, once made (EC2 jobs).
  snapshot_key     text,
  snapshot_sha256  text CHECK (snapshot_sha256 IS NULL OR snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  snapshot_bytes   bigint CHECK (snapshot_bytes IS NULL OR snapshot_bytes >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX job_inputs_one_code_per_job ON job_inputs (job_id) WHERE role = 'code';
CREATE INDEX job_inputs_job_idx ON job_inputs (job_id);

INSERT INTO job_inputs (job_id, role, source_type, source_ref)
SELECT id, 'code', 'github', jsonb_build_object('host', 'github.com', 'repo', repo, 'branch', branch)
FROM jobs;

-- 3. labels, and the git columns leave jobs/results -------------------------

-- The reporting view reads jobs.repo/branch: drop it first, rebuild below.
DROP VIEW IF EXISTS reporting.jobs;

ALTER TABLE jobs ADD COLUMN source_label text NOT NULL DEFAULT '';
UPDATE jobs SET source_label = repo;
ALTER TABLE jobs DROP COLUMN repo, DROP COLUMN branch;

ALTER TABLE results RENAME COLUMN repo TO source_label;
ALTER TABLE results ALTER COLUMN source_label SET DEFAULT '';

-- One row per job, with its owner, its code source and the EC2 instance it
-- ran on. repo/branch/commit are filled for git sources only.
CREATE VIEW reporting.jobs AS
SELECT
  j.id,
  j.name,
  u.username                        AS owner_username,
  u.display_name                    AS owner_name,
  j.status,
  j.execution_provider              AS provider,
  j.compute_type,
  j.execution_ref ->> 'instanceId'  AS instance_id,
  ci.source_type,
  j.source_label,
  ci.source_ref ->> 'repo'          AS repo,
  ci.source_ref ->> 'branch'        AS branch,
  ci.source_ref ->> 'commit'        AS commit,
  ci.snapshot_bytes                 AS input_bytes,
  j.folder,
  j.entry_script,
  j.hourly_rate_cents,
  j.max_runtime_seconds,
  j.duration_seconds,
  j.reserved_cents,
  j.cost_cents,
  j.hidden,
  j.created_at,
  j.updated_at,
  r.finalized_at,
  left(r.error, 500)                AS error
FROM jobs j
JOIN users u ON u.id = j.owner_user_id
LEFT JOIN job_inputs ci ON ci.job_id = j.id AND ci.role = 'code'
LEFT JOIN results r ON r.job_id = j.id;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'talon_grafana') THEN
    GRANT SELECT ON reporting.jobs TO talon_grafana;
  END IF;
END
$$;
