-- Expiry, kept pages, link expiry, and what the server knows about each file (src/Store.ts, src/Sweep.ts).
-- A page with `keep = 1` never expires; otherwise `expires_at` is set at every publish when the site has an expiry.
ALTER TABLE pages ADD COLUMN keep INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pages ADD COLUMN expires_at TEXT;
-- A share link may end by itself.
ALTER TABLE links ADD COLUMN expires_at TEXT;
-- `flagged`: what a text file looks like it holds (`GitHub token, private key`), found once at upload; NULL when clean.
-- `seen_at`: the last time a publish named the file, so the clean-up never takes a file a publish is about to use.
ALTER TABLE blobs ADD COLUMN flagged TEXT;
ALTER TABLE blobs ADD COLUMN seen_at TEXT;
-- A publish that was told to go ahead although a file was flagged says so on its version.
ALTER TABLE versions ADD COLUMN allowed_secrets INTEGER NOT NULL DEFAULT 0;
CREATE INDEX pages_expires ON pages (expires_at);
