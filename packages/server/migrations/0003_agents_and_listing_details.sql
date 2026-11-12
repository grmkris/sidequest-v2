-- A listing row carries everything its seller wrote, so one listing reads whole from it: its description, and its
-- price hint as JSON (`{"amount", "asset"}`), null when it has none.
ALTER TABLE listings ADD COLUMN description TEXT;
ALTER TABLE listings ADD COLUMN price_hint TEXT CHECK (price_hint IS NULL OR json_valid(price_hint));
-- Search reads the published listings newest first.
CREATE INDEX listings_by_state ON listings (state, id);

-- Agents, for their operators' lists: one row per agent, its grant's scopes as a JSON array with its expiry. Like the
-- other projections, a change to an agent not seen registered keeps its version in a row without an operator.
CREATE TABLE agents (
  id TEXT PRIMARY KEY NOT NULL,
  operator TEXT,
  name TEXT,
  scopes TEXT CHECK (scopes IS NULL OR (json_valid(scopes) AND json_type(scopes) = 'array')),
  expires_at INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
  version INTEGER NOT NULL CHECK (version >= 1),
  CHECK ((operator IS NULL) = (name IS NULL)),
  CHECK ((scopes IS NULL) = (expires_at IS NULL))
);
CREATE INDEX agents_by_operator ON agents (operator, id);
