-- EC2-launched jobs reserve their maximum cost when they start and settle
-- (refund the unused part) when they finish. reserved_cents is what was
-- charged at launch; cost_cents stays the final cost.
ALTER TABLE jobs
  ADD COLUMN reserved_cents bigint NOT NULL DEFAULT 0 CHECK (reserved_cents >= 0);

-- A job gets at most one settlement refund (the unique charge index already
-- covers the reservation itself).
CREATE UNIQUE INDEX budget_ledger_one_refund_per_job ON budget_ledger (job_id) WHERE kind = 'refund';
