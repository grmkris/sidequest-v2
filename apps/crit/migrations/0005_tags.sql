-- Optional comma-separated tags read from `<meta name="tags">` (or `<meta name="tag">`), for grouping on the index.
ALTER TABLE pages ADD COLUMN tags TEXT NOT NULL DEFAULT '';
