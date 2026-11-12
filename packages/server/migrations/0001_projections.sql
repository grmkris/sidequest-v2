-- The model's D1 projections. Each row carries the version (the source stream's sequence number) of the event it last
-- took, and a write changes a row only with a newer version, so a redelivered or replayed change does nothing.

-- Listings, for search: one row per listing, kept when it is withdrawn. A change to a listing not seen published yet
-- keeps its version in a row without a state, so the older publication cannot then overwrite it.
CREATE TABLE listings (
  id TEXT PRIMARY KEY NOT NULL,
  owner TEXT,
  title TEXT,
  tags TEXT CHECK (tags IS NULL OR (json_valid(tags) AND json_type(tags) = 'array')),
  state TEXT CHECK (state IS NULL OR state IN ('published', 'withdrawn')),
  version INTEGER NOT NULL CHECK (version >= 1),
  CHECK (state IS NULL OR (owner IS NOT NULL AND title IS NOT NULL AND tags IS NOT NULL))
);
CREATE INDEX listings_by_owner ON listings (owner);

-- Requests open for proposals. A closed job keeps its row with `open = 0`, so an older change cannot reopen it; a
-- job closed before it was seen opening is a row with its version only.
CREATE TABLE open_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  buyer TEXT,
  title TEXT,
  expires_at INTEGER,
  open INTEGER NOT NULL CHECK (open IN (0, 1)),
  version INTEGER NOT NULL CHECK (version >= 1),
  CHECK (open = 0 OR (buyer IS NOT NULL AND title IS NOT NULL AND expires_at IS NOT NULL))
);
CREATE INDEX open_jobs_by_expiry ON open_jobs (open, expires_at);

-- Each account's inbox: one item per source event (`id` is its `stream:seq`), read in `cursor` order.
CREATE TABLE inbox_items (
  account TEXT NOT NULL,
  id TEXT NOT NULL,
  cursor INTEGER NOT NULL CHECK (cursor >= 1),
  kind TEXT NOT NULL,
  job TEXT NOT NULL,
  room TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (account, id)
);
CREATE INDEX inbox_items_by_cursor ON inbox_items (account, cursor);
