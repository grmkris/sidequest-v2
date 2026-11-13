-- Listings and chain facts in the index (ADR-0003).

-- The latest NIP-99 listing (kind 30402) per seller key and `d` slug: greatest `created_at`, ties to the lowest event
-- id (NIP-01's rule for addressable events), so the row is the same whatever order the versions arrived in and a
-- rebuild from `events` alone makes it again. `topics` are its `t` tags as a JSON array; `price_*` its exact price
-- hint, if any; `network` the CAIP-2 chain of that price's asset. `status` is the listing's own label (`active` or
-- `sold`), never a filter the index applies. Named apart from phase 1's `listings` projection, which it will replace.
CREATE TABLE nostr_listings (
  pubkey TEXT NOT NULL,
  d TEXT NOT NULL,
  event_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  description TEXT NOT NULL,
  topics TEXT NOT NULL,
  price_amount TEXT,
  price_asset TEXT,
  network TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'sold')),
  published_at INTEGER NOT NULL,
  PRIMARY KEY (pubkey, d)
);
CREATE INDEX nostr_listings_newest ON nostr_listings (created_at DESC, event_id);

-- Every verified log of `SidequestOperator` and the escrow about a job's payment, one row per log, never updated: the
-- funded, delivered, rejected, settled and reclaimed facts of `@sidequest/fold`, as `fact` (its JSON). Keyed by where
-- the log is, so recording it again changes nothing and the table is the same whatever order the logs were read in.
-- `job` is set on fundings only: the operator's `bytes32 jobId` read as an event id (phase 1's ULID words read as ids
-- no request has). Facts are recorded only at the configured confirmation depth; one a deeper reorganisation undoes
-- stays here, since no fact is ever deleted. Not derived from `events`: a rebuild re-reads the chain.
CREATE TABLE chain_facts (
  chain TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('Funded', 'Delivered', 'Rejected', 'Settled', 'Reclaimed')),
  payment_hash TEXT NOT NULL,
  job TEXT,
  fact TEXT NOT NULL,
  PRIMARY KEY (chain, tx_hash, log_index)
);
CREATE INDEX chain_facts_by_job ON chain_facts (job, block, log_index);
CREATE INDEX chain_facts_by_payment ON chain_facts (payment_hash, block, log_index);

-- How far the chain log poller has read each chain: the last confirmed block it scanned. It only grows.
CREATE TABLE chain_cursors (
  chain TEXT PRIMARY KEY NOT NULL,
  scanned_to INTEGER NOT NULL
);
