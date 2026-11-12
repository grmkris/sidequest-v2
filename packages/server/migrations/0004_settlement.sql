-- Settlement through the escrow. Block numbers and amounts are decimal strings (they outgrow SQLite's integers in
-- principle); times are Unix seconds.

-- A payment request: the exact escrow payment for one job's accepted terms, between the payer the buyer chose and the
-- worker's wallet. One per id (`<job>:<terms digest>`); a cancelled one may be replaced, an open one only read.
CREATE TABLE payment_requests (
  id TEXT PRIMARY KEY NOT NULL,
  job TEXT NOT NULL,
  payer TEXT NOT NULL,
  receiver TEXT NOT NULL,
  payment_hash TEXT NOT NULL,
  from_block TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('begun', 'submitted', 'cancelled')),
  transaction_hash TEXT,
  CHECK ((state = 'submitted') = (transaction_hash IS NOT NULL))
);
CREATE INDEX payment_requests_by_job ON payment_requests (job);

-- A transaction the relayer means to send, recorded with its nonce before anything is sent, and with its signed bytes
-- before they are broadcast. No two intents of one signer share a nonce.
CREATE TABLE relayer_intents (
  id TEXT PRIMARY KEY NOT NULL,
  signer TEXT NOT NULL,
  nonce INTEGER NOT NULL CHECK (nonce >= 0),
  target TEXT NOT NULL,
  data TEXT NOT NULL,
  signed_transaction TEXT,
  transaction_hash TEXT,
  CHECK ((signed_transaction IS NULL) = (transaction_hash IS NULL)),
  UNIQUE (signer, nonce)
);

-- How far the chain reader has scanned one payment's logs, and the confirmed logs it found, as JSON.
CREATE TABLE reader_cursors (
  payment_hash TEXT PRIMARY KEY NOT NULL,
  scanned_to TEXT NOT NULL,
  logs TEXT NOT NULL CHECK (json_valid(logs) AND json_type(logs) = 'array')
);
