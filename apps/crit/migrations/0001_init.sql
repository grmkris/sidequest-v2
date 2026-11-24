-- crit's tables (src/Store.ts reads and writes them). Times are ISO strings.
-- A page is a name over immutable versions; `head_version` is the one served. Title, description and date come from
-- the version's index.html, for the index.
CREATE TABLE pages (
  slug TEXT PRIMARY KEY NOT NULL,
  head_version INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  removed_at TEXT
);
-- One publish: the manifest (JSON: path, sha256, size, contentType per file). The last five per page are kept.
CREATE TABLE versions (
  page TEXT NOT NULL,
  number INTEGER NOT NULL,
  manifest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  PRIMARY KEY (page, number)
);
-- The files R2 holds under blobs/<sha256>, so "which are missing" is one query.
CREATE TABLE blobs (
  sha256 TEXT PRIMARY KEY NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
-- Share links: only the token's hash is stored. A link opens one page until it is revoked.
CREATE TABLE links (
  hash TEXT PRIMARY KEY NOT NULL,
  page TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX links_page ON links (page);
