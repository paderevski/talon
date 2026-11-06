-- Read-only reporting views for dashboards (Grafana: infra/grafana).
--
-- The views live in their own schema and run with their owner's rights, so a
-- reporting role needs USAGE on "reporting" and SELECT on these views only:
-- no access to the tables behind them, and never to password hashes,
-- sessions or GitHub credentials, which no view exposes.
--
-- The role (talon_grafana) is created outside migrations: by
-- infra/server/db-bootstrap.sh on RDS (it needs the master user) and by
-- infra/grafana/grafana.sh on a laptop. The grants below apply when it
-- already exists; db-bootstrap.sh grants them too, so either order works.

CREATE SCHEMA IF NOT EXISTS reporting;

-- One row per job, with its owner and the EC2 instance it ran on.
CREATE OR REPLACE VIEW reporting.jobs AS
SELECT
  j.id,
  j.name,
  u.username                        AS owner_username,
  u.display_name                    AS owner_name,
  j.status,
  j.execution_provider              AS provider,
  j.compute_type,
  j.execution_ref ->> 'instanceId'  AS instance_id,
  j.repo,
  j.branch,
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
LEFT JOIN results r ON r.job_id = j.id;

-- Every ledger entry, with the account's owner and who made it.
CREATE OR REPLACE VIEW reporting.ledger AS
SELECT
  l.id,
  l.created_at,
  a.kind            AS account_kind,
  o.username        AS account_owner,
  l.kind,
  l.amount_cents,
  l.job_id,
  l.note,
  c.username        AS created_by
FROM budget_ledger l
JOIN budget_accounts a ON a.id = l.account_id
JOIN users o ON o.id = a.owner_user_id
LEFT JOIN users c ON c.id = l.created_by;

-- Current balances: student budgets and teacher pools.
CREATE OR REPLACE VIEW reporting.accounts AS
SELECT
  a.id,
  a.kind,
  o.username      AS owner_username,
  o.display_name  AS owner_name,
  a.balance_cents
FROM budget_accounts a
JOIN users o ON o.id = a.owner_user_id;

-- Users and their roles (no credentials).
CREATE OR REPLACE VIEW reporting.users AS
SELECT
  u.id,
  u.username,
  u.display_name,
  u.status,
  coalesce((SELECT array_agg(r.role::text ORDER BY r.role) FROM user_roles r WHERE r.user_id = u.id), '{}') AS roles,
  u.created_at,
  u.last_login_at
FROM users u;

-- Class rosters: one row per student in a class.
CREATE OR REPLACE VIEW reporting.class_students AS
SELECT
  c.id            AS class_id,
  c.name          AS class_name,
  c.block,
  c.term,
  t.username      AS teacher_username,
  s.username      AS student_username,
  c.archived_at
FROM classes c
JOIN class_members m ON m.class_id = c.id
JOIN users s ON s.id = m.user_id
LEFT JOIN users t ON t.id = c.teacher_id;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'talon_grafana') THEN
    GRANT USAGE ON SCHEMA reporting TO talon_grafana;
    GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO talon_grafana;
  END IF;
END
$$;
