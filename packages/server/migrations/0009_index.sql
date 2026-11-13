-- The index (ADR-0003): signed Nostr events Sidequest has seen, what they derive, where they still have to go, how far
-- each relay has been read, and how often each client and key has published lately.

-- Every event that passed validation, once. `validation` names what it passed beyond NIP-01's id and signature: the
-- profile, relay list or messaging relay list reader, the Sidequest vocabulary, or the NIP-99 listing reader. `source`
-- is where it was first seen (`publish`, or `relay:<url>`) and `first_seen` when, in Unix seconds.
CREATE TABLE events (
  id TEXT PRIMARY KEY NOT NULL,
  pubkey TEXT NOT NULL,
  kind INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL,
  sig TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  source TEXT NOT NULL,
  validation TEXT NOT NULL CHECK (validation IN ('profile', 'relayList', 'messagingRelays', 'sidequest', 'listing'))
);
CREATE INDEX events_by_kind ON events (kind, created_at);
CREATE INDEX events_by_author ON events (pubkey, kind, created_at);

-- Each event's tags that carry a value, by position: `#e`, `#p`, `#t` and the rest look an event up by tag.
CREATE TABLE event_tags (
  event_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (event_id, position)
);
CREATE INDEX event_tags_by_value ON event_tags (name, value, event_id);

-- The latest kind-0 profile per key: greatest `created_at`, ties to the lowest event id (NIP-01), so the row is the
-- same whatever order the events arrived in.
CREATE TABLE profiles (
  pubkey TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  name TEXT,
  about TEXT,
  picture TEXT
);

-- The latest relay list (10002) and messaging relay list (10050) per key, by the same rule. A 10002 list's `read` and
-- `write` relays as JSON arrays; a 10050 list's relays are where its author reads private messages, so `read` holds
-- them and `write` is empty.
CREATE TABLE relay_lists (
  pubkey TEXT NOT NULL,
  kind INTEGER NOT NULL CHECK (kind IN (10002, 10050)),
  event_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read TEXT NOT NULL,
  write TEXT NOT NULL,
  PRIMARY KEY (pubkey, kind)
);

-- How far the poller has read each relay: the start of its last complete pass, and its failures since then, with the
-- time before which it is not tried again.
CREATE TABLE relay_cursors (
  relay TEXT PRIMARY KEY NOT NULL,
  last_run_start INTEGER,
  failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  retry_after INTEGER NOT NULL DEFAULT 0
);

-- Events accepted through publish-through, one row per relay they must reach: pending until the relay answers OK (or
-- `duplicate:`), refused when it turns the event away for good, abandoned after too many failed attempts.
CREATE TABLE outbox (
  event_id TEXT NOT NULL,
  relay TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'refused', 'abandoned')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  PRIMARY KEY (event_id, relay)
);
CREATE INDEX outbox_due ON outbox (state, next_attempt_at);

-- Fixed-window counters for publish-through: one row per bucket (`ip:<address>` or `key:<pubkey>`) and window start.
CREATE TABLE rate_limits (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 1),
  PRIMARY KEY (bucket, window_start)
);
