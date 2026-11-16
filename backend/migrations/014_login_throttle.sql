-- Attempt counters for login and change-password throttling. Additive: the
-- older login_attempts table is left in place (a server still running the
-- previous release uses it during a rolling deploy) and is no longer written
-- by this release.
--
-- One row per bucket. scope 'login_ip' is one username from one client
-- address, 'login_user' is one username from any address, 'password' is one
-- signed-in user's change-password attempts (ip is ''). Attempts are counted
-- when they are reserved, before the password is checked, in a fixed window
-- that starts with the first attempt.
CREATE TABLE login_throttle (
  scope              text        NOT NULL,
  username_key       text        NOT NULL,
  ip                 text        NOT NULL DEFAULT '',
  attempts           integer     NOT NULL,
  window_started_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, username_key, ip)
);
CREATE INDEX login_throttle_window_idx ON login_throttle (window_started_at);
