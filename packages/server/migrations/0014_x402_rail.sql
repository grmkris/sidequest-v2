-- The x402 rail in the index (ADR-0006): pay-per-call listings, buyers' receipts, and the chain's facts that verify
-- them. Amounts in the x402 tables are written as 78 zero-padded digits (uint256's width), so SQLite compares them as
-- the integers they spell. Accounts are lowercase CAIP-10, as wallet links write them.

-- The latest listing's pay-per-call resource and payTo, `NULL` on an escrow listing.
ALTER TABLE nostr_listings ADD COLUMN x402_resource TEXT;
ALTER TABLE nostr_listings ADD COLUMN x402_pay_to TEXT;

-- Every pay-per-call listing version the index has seen, one row per event, never updated: a receipt names the
-- version it paid, whose price and payTo it is checked against, however the listing changed since. Derived from
-- `events`, so a rebuild makes it again.
CREATE TABLE x402_listing_versions (
  event_id TEXT PRIMARY KEY NOT NULL,
  pubkey TEXT NOT NULL,
  d TEXT NOT NULL,
  resource TEXT NOT NULL,
  pay_to TEXT NOT NULL,
  amount TEXT NOT NULL,
  asset TEXT NOT NULL,
  network TEXT NOT NULL
);

-- Every payment receipt (kind 8420), one row per event, never updated. `grant_id` is the grant an agent's key signed
-- it under, if any. Derived from `events`.
CREATE TABLE x402_receipts (
  event_id TEXT PRIMARY KEY NOT NULL,
  author TEXT NOT NULL,
  grant_id TEXT,
  created_at INTEGER NOT NULL,
  listing_pubkey TEXT NOT NULL,
  listing_d TEXT NOT NULL,
  version TEXT NOT NULL,
  payer TEXT NOT NULL,
  amount TEXT NOT NULL,
  asset TEXT NOT NULL,
  network TEXT NOT NULL,
  tx_hash TEXT NOT NULL
);
CREATE INDEX x402_receipts_by_listing ON x402_receipts (listing_pubkey, listing_d, created_at DESC);
CREATE INDEX x402_receipts_by_tx ON x402_receipts (network, tx_hash);

-- What the chain said of a transaction a receipt names, at the confirmation depth: `confirmed` (its ERC-20 transfers
-- are in `x402_transfers`) or `reverted`, both final; `pending` while it is unknown or not yet deep enough, with how
-- many times it was asked. Filled by the chain log poller, never from `events`; a rebuild re-reads the chain.
CREATE TABLE x402_tx_checks (
  network TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'confirmed', 'reverted')),
  attempts INTEGER NOT NULL,
  block INTEGER,
  PRIMARY KEY (network, tx_hash)
);

-- Every ERC-20 `Transfer` log of a confirmed transaction a receipt names, one row per log, never updated. `asset` is
-- the token as a lowercase CAIP-19 id.
CREATE TABLE x402_transfers (
  network TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  asset TEXT NOT NULL,
  from_account TEXT NOT NULL,
  to_account TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (network, tx_hash, log_index)
);
