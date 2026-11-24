-- A Talon user has at most one Microsoft (Entra) account. entraSignIn.js
-- checks this before linking, but two first sign-ins at the same moment
-- (two Microsoft accounts carrying one address) could both pass the check;
-- the loser now hits this index and is told to sign in again.
-- Additive: no rows change. Fails only if a user already has two Entra
-- identities, which must then be resolved by hand.
CREATE UNIQUE INDEX user_identities_one_entra_per_user
  ON user_identities (user_id)
  WHERE provider = 'entra';
