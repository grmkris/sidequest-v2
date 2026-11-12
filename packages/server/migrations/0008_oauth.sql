-- OAuth 2.1 for MCP clients. Times are Unix seconds. Every secret (an authorization code, a refresh token, a browser
-- binding) is stored only as its SHA-256; access tokens are agents' tokens in `agent_tokens`, tied to their connection.

-- A client that registered itself (RFC 7591). Its name is its own claim. A client known by its metadata document
-- (CIMD) is never stored: its id is that document's URL, fetched when it asks for authorization.
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT,
  -- A JSON array of the exact redirect URIs it registered.
  redirect_uris TEXT NOT NULL,
  registered_at INTEGER NOT NULL
);

-- A client's authorization request, waiting for the signed-in person's consent in the browser that opened it
-- (`binding_hash`, the hash of a cookie set on that browser). Deciding it sets `decided_at` once.
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

-- A connection: one person's consent for one client to act as one of their agents. It carries the one authorization
-- code that consent issued (redeemed once: the statement that sets `code_used_at` where it is still null) and is the
-- family of every token issued from it. Revoking it ends them all.
CREATE TABLE oauth_connections (
  id TEXT PRIMARY KEY NOT NULL,
  account TEXT NOT NULL,
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
CREATE INDEX oauth_connections_by_account ON oauth_connections (account, id);

-- A connection's refresh tokens. Each is used once (`used_at`), for the next one; a used one coming back is a stolen
-- copy, and revokes its connection.
CREATE TABLE oauth_refresh_tokens (
  token_hash TEXT PRIMARY KEY NOT NULL,
  connection TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  CHECK (expires_at > issued_at)
);
CREATE INDEX oauth_refresh_tokens_by_connection ON oauth_refresh_tokens (connection);

-- An access token issued over OAuth names its connection: it is accepted only while the connection stands, and only
-- at the resource the connection is for. Tokens a person issues by hand have none.
ALTER TABLE agent_tokens ADD COLUMN connection TEXT;
CREATE INDEX agent_tokens_by_connection ON agent_tokens (connection);
