-- Folder inside the repository the job runs from ('' = repository root).
-- The entry script is relative to it, the job's working directory is it, and
-- its requirements.txt (else the root one) is installed. Existing jobs keep
-- '' and run from the root as before.
ALTER TABLE jobs ADD COLUMN folder text NOT NULL DEFAULT '';
