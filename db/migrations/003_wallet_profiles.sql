CREATE TABLE wallet_profiles (
  wallet TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT NOT NULL,
  photo TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE wallet_profile_challenges (
  nonce TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX wallet_profile_challenges_expiry ON wallet_profile_challenges (expires_at);
