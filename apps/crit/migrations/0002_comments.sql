-- Comments on pages (src/CommentStore.ts). One row is one comment on one element (`anchor`) of one page.
-- `page` is the page's name plus the path inside it (`spike`, `spike/notes`, `spike/sub/page.html`); `slug` is the
-- name alone. A reply names the comment it answers (`parent_id`) and shares its thread's anchor. `status` is
-- meaningful on a thread's first comment. `author_key_hash` is who may delete it: a member's email or a guest's
-- per-browser key, hashed. `link_hash` is the share link a guest came through. Times are ISO strings.
CREATE TABLE comments (
  id TEXT PRIMARY KEY NOT NULL,
  page TEXT NOT NULL,
  slug TEXT NOT NULL,
  anchor TEXT NOT NULL,
  anchor_text TEXT NOT NULL,
  author TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('member', 'guest', 'agent')),
  author_key_hash TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  parent_id TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  status_by TEXT,
  status_at TEXT,
  link_hash TEXT
);
CREATE INDEX comments_page ON comments (page, created_at);
CREATE INDEX comments_slug ON comments (slug, created_at);
CREATE INDEX comments_parent ON comments (parent_id);
CREATE INDEX comments_link ON comments (link_hash, created_at);
