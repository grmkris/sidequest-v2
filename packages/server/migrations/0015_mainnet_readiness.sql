-- Indexes for reads that otherwise grow with everything ever stored, and the index's hide list
-- (docs/MAINNET-READINESS.md). Each was checked with EXPLAIN QUERY PLAN on SQLite, empty and with synthetic volume.

-- The settler's due query walks Funded facts only, already in its ORDER BY (block, log_index), instead of every fact.
CREATE INDEX chain_facts_funded ON chain_facts (block, log_index) WHERE kind = 'Funded';

-- The relayer's intents of one payment: every intent id is `<step>:<payment hash>[:…]`, so this expression is the
-- payment's hash. Reads must use exactly this expression (`intentPaymentHash` in `Escrow/EscrowChain.ts`).
CREATE INDEX relayer_intents_by_payment ON relayer_intents (substr(id, instr(id, ':') + 1, 66), nonce, id);

-- The gas the relayer committed today (the daily gas budget, `Escrow/LaunchCaps.ts`).
CREATE INDEX relayer_transactions_by_signed_at ON relayer_transactions (signed_at);

-- The minute's prune of ended rate-limit windows.
CREATE INDEX rate_limits_by_window ON rate_limits (window_start);

-- The outbox's due batch: pending rows only, in the order it reads them.
DROP INDEX IF EXISTS outbox_due;
CREATE INDEX outbox_due ON outbox (next_attempt_at, event_id, relay) WHERE state = 'pending';

-- Newest first within a kind, as the open requests page reads them, without a sort.
DROP INDEX IF EXISTS events_by_kind;
CREATE INDEX events_by_kind ON events (kind, created_at DESC, id);

-- The index's hide list (`Index/Moderation.ts`): event ids and public keys a stage's moderator hid. Lists leave them
-- out; reads by id still answer, labelled `hidden`. Nothing here deletes an event.
CREATE TABLE hidden_targets (
  target TEXT PRIMARY KEY NOT NULL CHECK (length(target) = 64),
  kind TEXT NOT NULL CHECK (kind IN ('event', 'pubkey')),
  reason TEXT NOT NULL,
  hidden_at INTEGER NOT NULL,
  hidden_by TEXT NOT NULL
);
