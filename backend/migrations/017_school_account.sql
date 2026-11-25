-- One School account at the top of the money tree. The yearly budget is
-- granted only into it; teacher pools, students and admins are funded by
-- transfers out of it (budget/ledger.js). It has no owner.
ALTER TABLE budget_accounts ALTER COLUMN owner_user_id DROP NOT NULL;

ALTER TABLE budget_accounts DROP CONSTRAINT budget_accounts_kind_check;
ALTER TABLE budget_accounts
  ADD CONSTRAINT budget_accounts_kind_check CHECK (kind IN ('school', 'personal', 'teacher_pool'));
ALTER TABLE budget_accounts
  ADD CONSTRAINT budget_accounts_school_has_no_owner CHECK ((kind = 'school') = (owner_user_id IS NULL));
CREATE UNIQUE INDEX budget_accounts_one_school ON budget_accounts (kind) WHERE kind = 'school';

-- Created here and again on demand (ensureSchoolAccount): wiping a test or
-- local database truncates every account.
INSERT INTO budget_accounts (owner_user_id, kind) VALUES (NULL, 'school')
ON CONFLICT (kind) WHERE kind = 'school' DO NOTHING;

-- No account may go below zero any more, admins included. Admins used to
-- skip the balance check, so a personal account can be negative now: bring
-- it back to zero with one entry that says why (the money was already
-- spent), so the cached balance still equals the ledger sum.
INSERT INTO budget_ledger (account_id, amount_cents, kind, note)
SELECT id, -balance_cents, 'grant', 'Opening top-up: cover earlier overspend before the no-negative rule'
FROM budget_accounts
WHERE balance_cents < 0;
UPDATE budget_accounts SET balance_cents = 0 WHERE balance_cents < 0;

-- Was: pools can't be overdrawn (personal accounts could).
ALTER TABLE budget_accounts DROP CONSTRAINT budget_accounts_check;
ALTER TABLE budget_accounts
  ADD CONSTRAINT budget_accounts_not_negative CHECK (balance_cents >= 0);

-- The reporting views joined the owner; School has none.
CREATE OR REPLACE VIEW reporting.ledger AS
SELECT
  l.id,
  l.created_at,
  a.kind            AS account_kind,
  CASE WHEN a.kind = 'school' THEN 'School' ELSE o.username END AS account_owner,
  l.kind,
  l.amount_cents,
  l.job_id,
  l.note,
  c.username        AS created_by
FROM budget_ledger l
JOIN budget_accounts a ON a.id = l.account_id
LEFT JOIN users o ON o.id = a.owner_user_id
LEFT JOIN users c ON c.id = l.created_by;

CREATE OR REPLACE VIEW reporting.accounts AS
SELECT
  a.id,
  a.kind,
  CASE WHEN a.kind = 'school' THEN 'School' ELSE o.username END AS owner_username,
  CASE WHEN a.kind = 'school' THEN 'School' ELSE o.display_name END AS owner_name,
  a.balance_cents
FROM budget_accounts a
LEFT JOIN users o ON o.id = a.owner_user_id;
