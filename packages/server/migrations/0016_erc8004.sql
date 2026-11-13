-- ERC-8004 identities (ADR-0007): who claims a token stands for which key, and what the chain says of each token.

-- Every claim, one row per event, never updated, so the table is the same set whatever order the events arrived in and
-- a rebuild from `events` alone makes it again. `author` signed it and should own the token; `subject` is the key the
-- token stands for (the author, or an agent the author granted); `registry` the identity registry as CAIP-10, in
-- lowercase; `agent_id` the token id as decimal digits. Whether a claim is verified is decided by the reads.
CREATE TABLE erc8004_claims (
  event_id TEXT PRIMARY KEY NOT NULL,
  author TEXT NOT NULL,
  subject TEXT NOT NULL,
  registry TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  mcp TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX erc8004_claims_by_subject ON erc8004_claims (subject, created_at);
CREATE INDEX erc8004_claims_by_token ON erc8004_claims (registry, agent_id);

-- The latest read of each claimed token on its registry's chain, at the confirmation depth: its owner's address in
-- lowercase (`NULL` when there is no such token) and its `agentURI`, as of `block`. A read replaces the row only from a
-- later block, so the row never moves back. Not derived from `events`: a rebuild reads the chain again. `read_at` is
-- when, in Unix seconds, so the oldest reads are repeated first.
CREATE TABLE erc8004_tokens (
  registry TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  owner TEXT,
  agent_uri TEXT NOT NULL,
  block INTEGER NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (registry, agent_id)
);
CREATE INDEX erc8004_tokens_by_read ON erc8004_tokens (read_at);
