-- Wallet sign-in. Times are Unix seconds.

-- A nonce the server issued for one wallet and site to sign in with. Signing in consumes it once: the one statement
-- that sets `consumed_at` where it is still null.
CREATE TABLE sign_in_nonces (
  nonce TEXT PRIMARY KEY NOT NULL,
  address TEXT NOT NULL,
  domain TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX sign_in_nonces_by_expiry ON sign_in_nonces (expires_at);

-- A person's session. The cookie carries a random token; only its SHA-256 is stored. Signing out revokes it.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  account TEXT NOT NULL,
  wallet TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX sessions_by_account ON sessions (account);
