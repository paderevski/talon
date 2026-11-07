-- EC2 jobs launch in the background (submit answers at once): while a job
-- is being prepared (code fetched and packed, instance started) it has no
-- execution_ref yet, and the launcher records its latest step here for the
-- Jobs page ("Copied 200 of 584 files"). launch_progress_at is also what
-- the reconciler uses to spot a launch that stopped (its web server
-- restarted): no progress for a while -> the job fails and is refunded.
ALTER TABLE jobs ADD COLUMN launch_progress text;
ALTER TABLE jobs ADD COLUMN launch_progress_at timestamptz;
