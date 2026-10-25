-- Failed-login counters for per-account throttling. Keyed by the lowercased
-- name that was typed (not a user id) so unknown names are throttled exactly
-- like real ones and the response never reveals which accounts exist.
CREATE TABLE login_attempts (
  username_key     text PRIMARY KEY,
  failures         integer     NOT NULL DEFAULT 0,
  last_failure_at  timestamptz NOT NULL DEFAULT now(),
  locked_until     timestamptz
);
CREATE INDEX login_attempts_last_failure_idx ON login_attempts (last_failure_at);
