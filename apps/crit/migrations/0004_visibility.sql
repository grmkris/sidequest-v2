-- Who may open a page: `team` (the default: signed-in members only) or `public` (anyone, at `/p/<slug>/`).
-- `visibility_by` is the member's name, or `agent` for the publish token; a page taken down goes back to `team`.
ALTER TABLE pages ADD COLUMN visibility TEXT NOT NULL DEFAULT 'team' CHECK (visibility IN ('team', 'public'));
ALTER TABLE pages ADD COLUMN visibility_by TEXT;
ALTER TABLE pages ADD COLUMN visibility_at TEXT;
-- A link's public name, so one link can be revoked without its token (which is stored only as a hash).
ALTER TABLE links ADD COLUMN id TEXT;
UPDATE links SET id = lower(hex(randomblob(8))) WHERE id IS NULL;
CREATE UNIQUE INDEX links_id ON links (id);
