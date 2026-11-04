-- Command-line arguments for the entry script, as the student typed them
-- (parsed shell-style at launch, never run through a shell). '' = none.
ALTER TABLE jobs ADD COLUMN script_args text NOT NULL DEFAULT '';
