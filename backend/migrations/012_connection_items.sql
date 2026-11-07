-- What a user chose to share with Talon through a connection (plan:
-- docs/connections-and-sources-plan.md). Google Drive uses the broad
-- drive.readonly scope so picked folders can be read with their contents;
-- Talon itself only ever touches the items listed here, which the student
-- picks in the Google Picker. Generic, so other file providers (Dropbox,
-- OneDrive) can keep their picks the same way. Removed with the link.
CREATE TABLE connection_items (
  user_id     uuid NOT NULL,
  provider    text NOT NULL,
  item_id     text NOT NULL CHECK (length(item_id) BETWEEN 1 AND 200),
  label       text NOT NULL DEFAULT '',
  kind        text NOT NULL DEFAULT 'file' CHECK (kind IN ('file', 'folder', 'google-doc')),
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider, item_id),
  FOREIGN KEY (user_id, provider) REFERENCES connections (user_id, provider) ON DELETE CASCADE
);
