-- Jobs and their results, owned by user id. Replaces the tracked JSON files.
-- Job ids keep the familiar "job-N" form.
CREATE SEQUENCE job_id_seq;

CREATE TABLE jobs (
  id                   text PRIMARY KEY DEFAULT ('job-' || nextval('job_id_seq')),
  owner_user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name                 text NOT NULL,
  repo                 text NOT NULL,
  branch               text NOT NULL DEFAULT 'main',
  entry_script         text NOT NULL DEFAULT 'train.py',
  status               text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  hidden               boolean NOT NULL DEFAULT false,
  hidden_at            timestamptz,
  hidden_by_user_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  hidden_reason        text,
  execution_provider   text,
  execution_ref        jsonb,
  result_sync_key      text,
  -- Where it runs and what it costs. compute_type and hourly_rate_cents are
  -- filled when jobs launch on their own EC2 instances; local runs are free.
  compute_type         text,
  hourly_rate_cents    numeric(12, 4) NOT NULL DEFAULT 0 CHECK (hourly_rate_cents >= 0),
  max_runtime_seconds  integer CHECK (max_runtime_seconds > 0),
  duration_seconds     integer CHECK (duration_seconds >= 0),
  cost_cents           bigint NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_owner_idx  ON jobs (owner_user_id, created_at DESC);
CREATE INDEX jobs_active_idx ON jobs (status) WHERE status IN ('queued', 'running');

-- One result per finished job.
CREATE TABLE results (
  id                text PRIMARY KEY,
  job_id            text NOT NULL UNIQUE REFERENCES jobs (id) ON DELETE CASCADE,
  execution_id      text NOT NULL DEFAULT '',
  name              text NOT NULL,
  repo              text NOT NULL,
  status            text NOT NULL CHECK (status IN ('completed', 'failed')),
  duration_seconds  integer CHECK (duration_seconds >= 0),
  output            text NOT NULL DEFAULT '',
  files             jsonb NOT NULL DEFAULT '[]'::jsonb,
  error             text,
  finalized_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Ledger entries can now point at real jobs, and a job is charged at most once.
ALTER TABLE budget_ledger
  ADD CONSTRAINT budget_ledger_job_fk FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE SET NULL;
CREATE UNIQUE INDEX budget_ledger_one_charge_per_job ON budget_ledger (job_id) WHERE kind = 'charge';
