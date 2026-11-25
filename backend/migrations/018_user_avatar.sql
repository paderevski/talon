-- A picked avatar: a DiceBear style id and a seed, drawn in the browser.
-- Both null (the default) shows the user's initials.
ALTER TABLE users ADD COLUMN avatar_style text;
ALTER TABLE users ADD COLUMN avatar_seed text;
ALTER TABLE users
  ADD CONSTRAINT users_avatar_both_or_neither CHECK ((avatar_style IS NULL) = (avatar_seed IS NULL));
