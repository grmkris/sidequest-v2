-- The agent gateway's own database: agents' sealed keys, OAuth for MCP clients, replay guards and rate limits. Times are
-- Unix seconds. Every OAuth secret and access token is stored only as its SHA-256. No plaintext key is ever stored.

-- One agent: a secp256k1 key the gateway made for one operator (a Nostr public key). The key is sealed with a per-agent
-- data key (XChaCha20-Poly1305, `key_sealed` = nonce || ciphertext), and the data key with the gateway's secret
-- (`data_key_sealed`), each bound to the agent's public key as associated data. Deleting the row destroys the key.
CREATE TABLE agents (
  pubkey TEXT PRIMARY KEY NOT NULL,
  operator TEXT NOT NULL,
  label TEXT NOT NULL,
  version INTEGER NOT NULL,
  data_key_sealed TEXT NOT NULL,
  key_sealed TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX agents_by_operator ON agents (operator, created_at);

-- A client that registered itself (RFC 7591), the same shape as the core's, read by `@sidequest/serving`.
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT,
  redirect_uris TEXT NOT NULL,
  registered_at INTEGER NOT NULL
);

-- An authorization request waiting for the operator's consent in the browser that opened it, the same shape as the
-- core's, read by `@sidequest/serving`.
CREATE TABLE oauth_requests (
  id TEXT PRIMARY KEY NOT NULL,
  binding_hash TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_name TEXT,
  client_kind TEXT NOT NULL CHECK (client_kind IN ('registered', 'published')),
  redirect_uri TEXT NOT NULL,
  state TEXT,
  code_challenge TEXT NOT NULL,
  resource TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER,
  CHECK (expires_at > created_at)
);
CREATE INDEX oauth_requests_by_expiry ON oauth_requests (expires_at);

-- A connection: one operator's consent for one client to act as one of their agents, with the single authorization
-- code it issued. Revoking it, or deleting its agent, ends every token issued from it.
CREATE TABLE oauth_connections (
  id TEXT PRIMARY KEY NOT NULL,
  operator TEXT NOT NULL,
  agent TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_name TEXT,
  client_kind TEXT NOT NULL CHECK (client_kind IN ('registered', 'published')),
  redirect_uri TEXT NOT NULL,
  resource TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  code_challenge TEXT NOT NULL,
  code_expires_at INTEGER NOT NULL,
  code_used_at INTEGER,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX oauth_connections_by_agent ON oauth_connections (agent);

-- A connection's tokens: access tokens (used many times until they expire) and refresh tokens (used once, for the
-- next pair; a used one coming back is a stolen copy and revokes its connection).
CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY NOT NULL,
  connection TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  revoked_at INTEGER,
  CHECK (expires_at > issued_at)
);
CREATE INDEX oauth_tokens_by_connection ON oauth_tokens (connection);

-- NIP-98 authorizations already used for a request that changes something, kept until they could no longer verify,
-- so a captured header cannot be sent again.
CREATE TABLE used_authorizations (
  event_id TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Fixed-window counters, read by `@sidequest/serving/RateLimiter`.
CREATE TABLE rate_limits (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);
