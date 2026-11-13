# Phase 2 specification: Sidequest on signed events

This is phase 2 of the [roadmap](ROADMAP.md) as built. The decisions are [ADR-0003](adr/0003-nostr-native.md) (Nostr-native coordination) and [ADR-0004](adr/0004-rooms-on-nip-17.md) (rooms on NIP-17); the money decisions of [ADR-0002](adr/0002-usdc-chains-and-escrow.md) stand. Phase 1 ([PHASE-1.md](PHASE-1.md)) is history: its code is deleted.

## The rule

Only wallet signatures bind. Everything else (requests, proposals, accepts, delivery notes, statements, reviews, grants) is a signed Nostr event that carries coordination. Sidequest's database is an index of the valid events it has seen and the chain's logs, the same whatever order they arrived in. There are no accounts, no sessions and no cookies: a person is a Nostr public key, and their EVM wallet is linked to it by a signature in both directions. Nothing Sidequest holds is a person's key. Rooms are end-to-end encrypted and exist nowhere on Sidequest's servers.

## Packages

| Package               | Contents                                                                                                                                                                                                     |
| :-------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol`   | Shared schemas: amounts, assets, networks, terms and their digest, typed data, the HTTP API (`SidequestApi`: status, events and the index's reads, the escrow). Browser-safe; depends on nothing of ours.    |
| `packages/nostr`      | Events, signatures, NIP-19, NIP-44, NIP-49, NIP-59, NIP-98, the Sidequest kinds, wallet-link typed data, the relay client and rooms (`@sidequest/nostr/rooms`). Browser- and Workers-safe; no Nostr library. |
| `packages/fold`       | A job's state as a pure function of its signed events and the chain's facts, and the index's job reads (`@sidequest/fold/api`). Run by the server and the website alike.                                     |
| `packages/settlement` | Server-only: the escrow's payment and typed data, operator calls, the relayer (with nonce repair), the arbitrator's signature, the chain's job logs.                                                         |
| `packages/serving`    | What the core and the gateway share: D1 statements, rate limits, OAuth 2.1 for MCP clients, MCP protocol revisions.                                                                                          |
| `packages/server`     | The core's Workers: the edge, the API Worker (the index, the escrow, the settler, the chain log poller) and the relay pipe.                                                                                  |
| `apps/web`            | The website, Foldkit only: identity, listings, requests, the job page with its money steps and rooms, the agents page, the inbox.                                                                            |
| `apps/gateway`        | The agent gateway: its own Worker and D1, agents' sealed keys, the grant gate, OAuth and MCP ([README](../apps/gateway/README.md)).                                                                          |
| `contracts/`          | `SidequestOperator` v2 over the audited `AuthCaptureEscrow` ([README](../contracts/README.md)).                                                                                                              |

## Events and kinds

Sidequest's kinds are one block, 8410–8420, in NIP-01's regular range (`packages/nostr/src/Kinds.ts`). Every Sidequest event carries `["sq", "2"]`; one about money names its CAIP-2 network in `sq-net`; one an agent's key signs under a grant names it in `sq-grant`.

| Kind | Event         | Content                                                                                                          |
| :--- | :------------ | :--------------------------------------------------------------------------------------------------------------- |
| 8410 | Wallet link   | A CAIP-10 wallet, when, and the wallet's EIP-712 signature of the key (`LinkNostrKey`).                          |
| 8411 | Request       | Title, description, expiry. Its event id is the job's id and the escrow's `jobId`.                               |
| 8412 | Proposal      | The job, its buyer, the terms and their digest (`sha256(JCS(terms))`), the wallet to pay, valid-until, previous. |
| 8413 | Accept        | The buyer accepts one proposal and its digest. A signal: nothing binds until the buyer's wallet funds.           |
| 8414 | Delivery note | The worker's note of a delivery's hash, before the wallet records it on chain.                                   |
| 8415 | Statement     | `withdraw_request`, `withdraw_proposal` or `rejection_reason`.                                                   |
| 8416 | Review        | One party's review of the other after settlement.                                                                |
| 8418 | Grant         | An operator lets an agent's key act: scopes (`discuss`, `propose`, `accept`, `deliver`), a window, a label.      |
| 8419 | Revocation    | The operator revokes a grant. A revoked grant authorises nothing, whenever the revocation arrived.               |

Standard kinds read and written: profiles (0), relay lists (10002), inbox relays (10050), NIP-99 listings (30402, 30403), and for rooms the chat rumor (14), seal (13), gift wrap (1059) and NIP-42 authentication (22242). There is no `pay` scope: agents never pay.

## The index

The API Worker's index takes signed events in two ways: `POST /api/events` from any client, and a poll of the stage's relays every ten minutes (with a look-back of two days and fifteen minutes, for backdated gift wraps). It also relays what it is sent to the stage's relays and the author's own write relays, from an outbox, every minute.

It keeps only valid events of the kinds it reads: a bad signature, a schema its kind refuses, more than 64 KiB of content or 256 tags is refused. It labels instead of judging: a wallet link whose signature does not recover to its wallet (an ERC-1271 contract wallet, which needs a chain call the index does not make) is stored as `unverified`; a superseded proposal, a revoked grant or an expired request is a label the fold reads. Rows derived from events (profiles, relay lists, wallet links, grants, revocations, listings) are the same for the same events in any order. Publishing is rate-limited per client address (120 a minute) and, once the signature verified, per key (30 a minute). The signed request and every proposal the chain funded are kept for good (`kept_events`), since the chain holds only their digest.

Reads, all public and cacheable: an event (`/api/events/:id`), what the index knows of a key (`/api/people/:pubkey`: its profile, relay lists, linked wallets, and the grants it gave and was given), names of up to 50 keys (`/api/people?pubkeys=`), the jobs a key requested or proposed on (`/api/people/:pubkey/jobs`, at most 25, what the website computes the inbox from), which key a wallet is linked to (`/api/wallets/:account`), listings (`/api/index/listings`, `/api/index/listings/:pubkey/:slug`) and jobs (`/api/index/jobs?stage=open`, `/api/index/jobs/:id`).

## The fold

A job is folded from its request, proposals, accepts, statements, delivery notes and reviews and the chain's facts about it (`packages/fold`). Before funding its stage comes from events: `open`, `proposed`, `accepted`, `closed`. From funding on it comes from the chain alone: `funded`, `delivered`, `rejected`, then `released`, `ruled`, `refunded` or `reclaimed`. An agent's event counts as its operator's when the grant it names is that operator's, for that key, has the action's scope, holds the event's `created_at` in its window and is not revoked; otherwise it counts as the agent key's own. Deadlines (delivery overdue, review window open, arbitration open, reclaimable) are labels against the chain's time. The fold is pure: the index and the website run the same code on the same inputs.

## Escrow and the settler

The escrow is `AuthCaptureEscrow` with `SidequestOperator` v2 on Arc testnet. Each money step is a wallet signature the API relays from Sidequest's relayer, which pays the gas; the contract verifies the signature, and the server only refuses what it should not pay gas for, simulates, and relays. The endpoints (`EscrowApi`, under `/api/index/jobs/:id/…`) are: the funding quote and the fund (the buyer's ERC-3009 authorization), the delivery to sign and the delivery (the worker's wallet), the delivery delegation to sign and the delegated delivery (an agent's key under the worker's one-job delegation), the approval and the rejection (the buyer's wallet), the ruling (a NIP-98 authorization by the stage's arbitration key, then the interim arbitrator's signature), the payment's state and the funded terms. Funding is relayed only when the request and the proposal are indexed and valid, the proposal names the request's author and is still offered, the payment pays the proposal's `payTo`, and the payer's wallet has a verified link to the buyer's key.

The chain log poller reads the operator's and the escrow's logs into `chain_facts` every minute, only at the confirmation depth, from the operator's deployment block on a new stage. The settler runs after it, on the same minute Cron Trigger: for every funded payment of an indexed job that has not ended, it compares the chain's time with the on-chain deadlines and relays the call that is due (`refundUndelivered`, `settleAfterReview`, `settleUnruled`), at most three attempts per call, never twice. Both are stateless over D1. The relayer has one key and one nonce sequence for every call, keeps its intents in D1 and repairs a stuck one before it relays the next.

## Who may call what

Every endpoint may be called from any origin. No endpoint reads a cookie, a session or any credential a browser attaches by itself; what changes state carries its own authority:

| Endpoint                                       | Authority                                                        |
| :--------------------------------------------- | :--------------------------------------------------------------- |
| `GET` anything                                 | None: public reads.                                              |
| `POST /api/events`                             | The event's Nostr signature, by its author.                      |
| `POST …/proposals/:proposal/funding`           | The payer wallet's ERC-3009 authorization, checked on chain.     |
| `POST …/delivery`, `…/approval`, `…/rejection` | The party's wallet signature over the operator's typed data.     |
| `POST …/delegated-delivery`                    | The worker wallet's delegation and the delegate key's signature. |
| `POST …/ruling`                                | A NIP-98 authorization by the stage's arbitration key.           |

So there is no same-origin rule: a page on another site that makes a browser send one of these does no more than the signer could themselves. The API sends no CORS headers and grants no preflight, so another site's page cannot send JSON or read an answer; the gateway and other servers call it server-side and need none (`packages/server/test/Api.test.ts`). The edge's relay pipe is the one exception with an origin rule: it refuses a WebSocket from another origin.

## The gateway

An agent hosted in an assistant cannot hold a key, so the agent gateway holds one per agent, sealed, and serves MCP and OAuth on its own origin. It reaches the core only through the public API, as any third party could; the core knows nothing of it. Operators are keys: every operator request carries NIP-98. The website's agents page reaches the gateway through the edge's `/gateway` proxy, which forwards no cookie. See its [README](../apps/gateway/README.md).

## Rooms

A job's rooms are NIP-17 conversations behind one `RoomTransport` interface (`@sidequest/nostr/rooms`): gift wraps on the members' inbox relays, ordered by a Lamport clock, membership run by the room's founders (the buyer and the bidder). The browser reaches relays through the edge's relay pipe (`/relay?url=`), a same-origin WebSocket that stores nothing, so the content security policy stays `connect-src 'self'`. A proposal may be private to its room; a disclosed seal proves one message to an arbitrator and nothing else. Gateway agents join rooms with their own tools and a limit of six consecutive agent turns.

## What a stage needs

From the deploying shell (`alchemy.run.ts`); each is optional, and without it the feature is off:

| Variable                                                                                                                     | What it turns on                                                                          |
| :--------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------- |
| `SIDEQUEST_OPERATOR_ADDRESS`, `SIDEQUEST_TREASURY_ADDRESS`, `SIDEQUEST_ARBITRATOR_ADDRESS`, `SIDEQUEST_RELAYER_KEY` (secret) | Settlement: the escrow endpoints, the chain log poller and the settler. All four or none. |
| `SIDEQUEST_ARBITRATOR_KEY` (secret), `SIDEQUEST_ARBITRATION_PUBKEY`                                                          | Rulings: the interim arbitrator's key, and the Nostr key that may ask for one.            |
| `SIDEQUEST_OPERATOR_DEPLOY_BLOCK`                                                                                            | Where a new stage's chain log poller starts; unset, at the confirmed head.                |
| `SIDEQUEST_CONFIRMATIONS`, `SIDEQUEST_FEE_BPS`, `SIDEQUEST_ARC_RPC_URL`                                                      | Defaults 3, 500 and Arc testnet's public RPC.                                             |
| `SIDEQUEST_RELAYS`, `SIDEQUEST_RELAY_OVERLAP_SECONDS`, `SIDEQUEST_INDEX_KEY` (secret)                                        | The index's relays to poll and publish to, and its NIP-42 key.                            |
| `SIDEQUEST_DEFAULT_INBOX_RELAYS`                                                                                             | The inbox relays the identity page offers people who have none.                           |
| `SIDEQUEST_GATEWAY_SECRET` (secret), then `SIDEQUEST_GATEWAY_URL`                                                            | The agent gateway, and (from a deploy before) the website's way to it.                    |

A half-configured settlement fails the deploy, naming the variables at fault and never their values.

## Deploying over phase 1

A stage deployed before this phase (the `preview` stage) holds phase 1's Durable Object classes on its API Worker (`SidequestWorker`): one per aggregate (`AccountAggregate`, `WalletClaimAggregate`, `AgentAggregate`, `ListingAggregate`, `JobAggregate`, `RoomAggregate`), view, policy, projection and stream of the model, and one per saga workflow. The pinned Alchemy (`@alchemy.run/cloudflare` 2.0.0-beta.84, `src/Workers/WorkerProvider.ts`) records every class a Worker hosts in its `alchemy:dos:` script tags. On the next deploy it compares them with the classes the new Worker binds, which are none, checks against the account's namespace listing that this script still hosts each one, and uploads Cloudflare's declarative `exports` map with `{ type: "durable-object", state: "deleted" }` for each. So the deploy deletes them, and their stored state with them, with no shim and no hand-written migration. A class Cloudflare no longer lists for the script fails the deploy (`MissingDurableObjects`) rather than being guessed at.

D1 migration `0013_drop_phase_one.sql` drops phase 1's tables (sign-in nonces and sessions, the core's OAuth and agent tokens, the model's projections, payment requests and reader cursors). The relayer's intents and every index table stay.

## Evidence

The gate rehearsals and their results are in [STATUS.md](STATUS.md). `bun run gate:rehearse` runs the technical gate on Anvil (or, with `REHEARSAL_CHAIN=arc-testnet`, on Arc testnet); `bun run gate:rehearse:browser` runs two hires on the website in Chromium on Anvil.
