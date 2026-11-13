-- Phase 1 leaves the database. Its accounts, wallet sign-in, agents, listings, jobs, rooms and inbox ran on Durable
-- Objects and these D1 tables; phase 2 (ADR-0003) replaced them with signed events, the index and the fold, and the
-- code that wrote and read them is deleted. Each table's indexes go with it. Kept: the relayer's `relayer_intents` and
-- `relayer_transactions` (the escrow relays through the same key and nonce sequence) and every table of the index.

-- Wallet sign-in and sessions (0002).
DROP TABLE IF EXISTS sign_in_nonces;
DROP TABLE IF EXISTS sessions;

-- The core's OAuth issuer and agent tokens (0005, 0008); the agent gateway keeps its own in its own database.
DROP TABLE IF EXISTS oauth_refresh_tokens;
DROP TABLE IF EXISTS oauth_connections;
DROP TABLE IF EXISTS oauth_requests;
DROP TABLE IF EXISTS oauth_clients;
DROP TABLE IF EXISTS agent_tokens;

-- The model's projections: agents, account names, listings, open jobs, a party's jobs, the inbox (0001, 0003, 0006).
DROP TABLE IF EXISTS agents;
DROP TABLE IF EXISTS account_names;
DROP TABLE IF EXISTS listings;
DROP TABLE IF EXISTS open_jobs;
DROP TABLE IF EXISTS job_parties;
DROP TABLE IF EXISTS party_jobs;
DROP TABLE IF EXISTS inbox_items;

-- Phase 1's payment requests and its per-payment chain reader's cursors (0004); the chain log poller keeps its own.
DROP TABLE IF EXISTS payment_requests;
DROP TABLE IF EXISTS reader_cursors;
