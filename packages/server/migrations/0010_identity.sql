-- Identity in the index (ADR-0003): which wallets each key links, and which agents each key lets act for it. Both are
-- facts, one row per event and never updated, so the tables are the same set whatever order the events arrived in and
-- a rebuild from `events` alone makes them again. Who wins is decided by the reads, inside each query.

-- Every wallet link, labelled. `verified` when the wallet's EIP-712 signature of `LinkNostrKey(pubkey, issuedAt)`
-- recovers to the account's address; `unverified` when it does not, which is what an ERC-1271 contract wallet's
-- signature looks like without a call to the chain. Of the verified links naming an account, the one with the greatest
-- `issued_at`, ties to the lowest event id, is the account's current key; an unverified link never is.
CREATE TABLE wallet_links (
  event_id TEXT PRIMARY KEY NOT NULL,
  account TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  verification TEXT NOT NULL CHECK (verification IN ('verified', 'unverified'))
);
CREATE INDEX wallet_links_by_account ON wallet_links (account, verification, issued_at DESC, event_id);
CREATE INDEX wallet_links_by_key ON wallet_links (pubkey, verification);

-- Every agent grant: its author (the operator) lets `agent` act with `scopes` (a JSON array) from `not_before` until
-- `expires_at`. Whether it is revoked is read from `grant_revocations`; whether it has expired, from the time of the read.
CREATE TABLE agent_grants (
  event_id TEXT PRIMARY KEY NOT NULL,
  operator TEXT NOT NULL,
  agent TEXT NOT NULL,
  scopes TEXT NOT NULL,
  not_before INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX agent_grants_by_operator ON agent_grants (operator, created_at);
CREATE INDEX agent_grants_by_agent ON agent_grants (agent, created_at);

-- Every revocation, by whoever signed it. It revokes a grant only when its author is the grant's operator, which the
-- reads check, so a revocation may arrive before its grant, and a stranger's revocation is kept and counts for nothing.
CREATE TABLE grant_revocations (
  event_id TEXT PRIMARY KEY NOT NULL,
  grant_id TEXT NOT NULL,
  pubkey TEXT NOT NULL
);
CREATE INDEX grant_revocations_by_grant ON grant_revocations (grant_id, pubkey);
