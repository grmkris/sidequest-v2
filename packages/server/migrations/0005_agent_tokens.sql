-- Agents' access tokens for MCP. Times are Unix seconds. The agent sends a random token as a bearer credential; only
-- its SHA-256 is stored. A token names one agent and nothing else: who operates the agent and what it may do are read
-- from the agent's aggregate on every request. Revoking sets `revoked_at` once.
CREATE TABLE agent_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  agent TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK (expires_at > issued_at)
);
-- An operator lists one agent's tokens by id.
CREATE INDEX agent_tokens_by_agent ON agent_tokens (agent, id);
