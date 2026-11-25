-- Who may start jobs. NULL (every existing user) means the role default:
-- students and admins can, teachers cannot (auth/jobPermission.js). An admin
-- sets true to let someone run jobs (a teacher) or false to stop them (a
-- student), separately from their budget.
-- Additive: no existing row changes meaning.
ALTER TABLE users ADD COLUMN can_run_jobs boolean;
