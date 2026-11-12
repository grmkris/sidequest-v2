-- The relayer repairs a nonce the chain never used (a transaction refused or dropped): it signs the call again at the
-- same nonce with higher fees, or releases the nonce with a transfer of nothing to itself. So an intent can hold several
-- signed transactions, and it ends when the chain uses its nonce.

-- Where an intent stands: open until its nonce is used, then mined (by one of its calls) or released (by its release,
-- or by a transaction it never signed). `outcome_hash` names the transaction that used the nonce; `reason` says why the
-- intent was released, or why its mined call failed. `signed_transaction` and `transaction_hash` are no longer written:
-- every signed transaction is in `relayer_transactions`.
ALTER TABLE relayer_intents ADD COLUMN state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'mined', 'released'));
ALTER TABLE relayer_intents ADD COLUMN outcome_hash TEXT;
ALTER TABLE relayer_intents ADD COLUMN reason TEXT;
CREATE INDEX relayer_intents_open ON relayer_intents (signer, state, nonce);

-- Every transaction signed for an intent, recorded before it is broadcast. `sequence` orders an intent's transactions
-- at one nonce, and its uniqueness is what lets two relays race: only one records the next transaction there. Fees are
-- decimal strings in wei; `signed_at` is Unix milliseconds; `reason` is why it replaced the one before; `refused` is
-- what the node answered when it refused it outright.
CREATE TABLE relayer_transactions (
  hash TEXT PRIMARY KEY NOT NULL,
  intent TEXT NOT NULL,
  nonce INTEGER NOT NULL CHECK (nonce >= 0),
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('call', 'release')),
  raw TEXT NOT NULL,
  max_fee_per_gas TEXT NOT NULL,
  max_priority_fee_per_gas TEXT NOT NULL,
  signed_at INTEGER NOT NULL,
  reason TEXT,
  refused TEXT,
  UNIQUE (intent, nonce, sequence)
);

-- Transactions signed before this migration move over as each intent's first; their fees are unknown, so a replacement
-- prices itself from the current estimate alone.
INSERT INTO relayer_transactions (hash, intent, nonce, sequence, kind, raw, max_fee_per_gas, max_priority_fee_per_gas,
  signed_at)
SELECT transaction_hash, id, nonce, 0, 'call', signed_transaction, '0', '0', 0
FROM relayer_intents WHERE signed_transaction IS NOT NULL;
