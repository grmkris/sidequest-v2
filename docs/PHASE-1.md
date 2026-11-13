# Phase 1 specification: the first complete hire

> **Historical.** This describes phase 1 as it was built, server-authoritative, with accounts, wallet sign-in and a model on Durable Objects. Phase 2 replaced all of it and its code is deleted; [PHASE-2.md](PHASE-2.md) describes the product as it is. Its gate evidence is kept, marked superseded, in [STATUS.md](STATUS.md).

This is the build specification for phase 1 of the [roadmap](ROADMAP.md). Decisions behind it are in [ADR-0001](adr/0001-v2-scope.md) and [ADR-0002](adr/0002-usdc-chains-and-escrow.md). One chain (Arc testnet), plain wallet USDC, no SIDE, no Nostr, no unified balance.

## The journey phase 1 must support

1. A person signs in with a wallet and registers an agent they operate, with a grant.
2. A seller (person or agent) publishes a listing.
3. A buyer (person, or their agent) posts a work request.
4. Sellers submit versioned proposals; either side can ask for changes in a private room per bidder.
5. The buyer accepts one exact proposal version. That creates the agreement.
6. The buyer funds the escrow from their wallet. Agents never pay in phase 1.
7. The worker delivers; the delivery hash goes on chain.
8. The buyer approves, or stays silent until the review window ends (acceptance), or rejects.
9. A rejection opens a dispute that an arbitrator settles with a signed ruling.
10. The escrow pays the worker, refunds the buyer or splits. Both sides leave a review.
11. If nothing is ever delivered, the buyer reclaims after the escrow expires.

## Vocabulary

- **Actor:** who is acting on a request: an account, optionally through one of its agents with the scopes of that agent's grant. Authority is judged when a command arrives, never from a client-supplied time.
- **Job:** the lifecycle of one work request. Its id identifies the request, the agreement, the escrow payment and the rooms.
- **Terms:** `{ title, deliverables[], amount, asset, network, deliveryDeadline, reviewWindowSeconds, disputeWindowSeconds, arbitrationWindowSeconds, rail }`. `termsDigest = sha256(JCS(terms))`, hex.
- **Amount:** a non-negative integer in the asset's atomic units, carried as a decimal string. Never a float.
- **AssetRef / NetworkRef:** CAIP-19 and CAIP-2 identifiers plus decimals, from a registry in `packages/protocol`. Phase 1 registers USDC on Arc testnet only.

## Packages

| Package               | Phase 1 contents                                                                                                                                                                                                 |
| :-------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol`   | Ids, Amount, AssetRef, NetworkRef, Terms and its digest, the record schemas, the HTTP API contract and the MCP tool contracts. Browser-safe.                                                                     |
| `packages/domain`     | The model on `@alchemy.run/domain`: aggregates, commands, events, rejections, views, policies and the settlement saga, with story tests. Imports only `@alchemy.run/domain`, `effect` and `@sidequest/protocol`. |
| `packages/settlement` | Server-only. The payment adapter interface, the escrow adapter, the chain reader and the receipt verifier.                                                                                                       |
| `packages/server`     | Workers: hosting the model on Durable Objects, D1 projections, sessions, the HTTP API and the MCP endpoint.                                                                                                      |
| `contracts/`          | Foundry workspace: `SidequestOperator` and its tests.                                                                                                                                                            |
| `apps/web`            | Browse, sign in, approve, pay and review.                                                                                                                                                                        |

## Domain model

Aggregates are small and each is one Durable Object instance. Cross-aggregate rules use policies or sagas, never a shared transaction.

| Aggregate | Key       | Holds                                                                                            | Commands                                                 |
| :-------- | :-------- | :----------------------------------------------------------------------------------------------- | :------------------------------------------------------- |
| `Account` | AccountId | Display name, linked wallet addresses (CAIP-10)                                                  | `RegisterAccount`, `LinkWallet`, `RenameAccount`         |
| `Agent`   | AgentId   | Operator account, name, grant (scopes, expiry), revoked flag                                     | `RegisterAgent`, `GrantAgent`, `RevokeGrant`             |
| `Listing` | ListingId | Owner, title, description, tags, price hint, state                                               | `PublishListing`, `UpdateListing`, `WithdrawListing`     |
| `Job`     | JobId     | The request, proposals per bidder, the agreement, funding, delivery, review, dispute and outcome | see below                                                |
| `Room`    | RoomId    | Members, messages, consecutive agent-turn counter, paused agents                                 | `OpenRoom`, `PostMessage`, `PauseAgents`, `ResumeAgents` |

Grant scopes: `discuss`, `propose`, `accept`, `deliver`. There is no `pay` scope in phase 1.

### The Job aggregate

States: `Open → Awarded → Funded → Delivered → Settled`, with `Disputed` between `Delivered` and `Settled`, and the terminal states `Cancelled` and `Expired`.

| Command            | Who                                 | Rule                                                                                                                                     |
| :----------------- | :---------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------- |
| `PostRequest`      | buyer                               | Creates the job in `Open` with an expiry.                                                                                                |
| `SubmitProposal`   | bidder with `propose`               | Version 1, or `previous + 1` naming the bidder's own head. Not the buyer.                                                                |
| `RequestChange`    | buyer                               | Names the bidder's head proposal and digest.                                                                                             |
| `AcceptProposal`   | buyer, or their agent with `accept` | Must name the bidder's head version and its exact `termsDigest`; a superseded version or wrong digest is rejected. Moves to `Awarded`.   |
| `CancelRequest`    | buyer                               | Only while `Open`.                                                                                                                       |
| `ExpireRequest`    | system                              | Scheduled at the request's expiry; only while `Open`.                                                                                    |
| `RecordFunding`    | system                              | From the chain reader: the escrow authorization for this job's payment hash, with the verified receipt. Moves to `Funded`.               |
| `SubmitDelivery`   | worker with `deliver`               | Records the artifact hash and URL; only while `Funded` and before the delivery deadline. The worker then signs that hash onto the chain. |
| `RecordDelivery`   | system                              | From the chain reader: the delivery hash posted on chain. Moves to `Delivered` and starts the review window.                             |
| `RejectDelivery`   | buyer                               | Records the buyer's reason only. The rejection itself is the buyer's signature, relayed to the chain.                                    |
| `RecordRejection`  | system                              | From the chain reader: the rejection observed on chain. Moves to `Disputed`.                                                             |
| `RecordRuling`     | system                              | The arbitrator's verified ruling: pay, refund or split in basis points.                                                                  |
| `RecordSettlement` | system                              | From the chain reader: capture, void or reclaim observed on chain. Moves to `Settled` with the outcome.                                  |
| `LeaveReview`      | buyer or worker                     | Once each, only after `Settled`.                                                                                                         |

The chain is the authority for money. `Record*` commands are sent only by the settlement saga after the chain reader has verified a receipt; nothing a client sends can mark a job funded or settled. An approval is not a command: the buyer signs it, the server relays it, and it reaches the job as the settlement the reader observes.

### Rooms

- A negotiation room opens per job and bidder when the first proposal or question arrives. An engagement room opens when the job is awarded.
- Membership follows the job's roles. A newcomer sees no earlier history.
- Server-side turn limit: at most 6 consecutive agent messages; the 7th is rejected until a person posts. A person can pause and resume their own agents.
- Messages are text. A message never changes a job.

### Views and projections

- `JobSummary` by job, one per audience (buyer, bidder, public).
- D1 projections: `listings` (search), `jobs` (open requests), `inbox` (per account: items with a cursor).

## Settlement

- **Escrow:** `AuthCaptureEscrow` v1.1 at `0xf96815976523E00e65Be8f34cA5e64b4f41EB19c` and its `ERC3009PaymentCollector` at `0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88`, both present on Arc testnet.
- **`SidequestOperator`** is the escrow's `operator`. For each job it stores the terms digest, the windows and the arbitrator. It exposes:
  - `fund`: forwards the buyer's ERC-3009 authorization to `authorize`. It checks that the escrow's `authorizationExpiry` is at least delivery deadline + review + dispute + arbitration + margin.
  - `deliver(hash)`: callable by the receiver before the delivery deadline.
  - `approve`: with the buyer's signature, captures at once.
  - `settleAfterReview`: callable by anyone after the review window if no rejection was recorded; captures.
  - `reject`: with the buyer's signature, inside the review window.
  - `rule`: with the arbitrator's EIP-712 ruling; captures the worker's share and voids the rest.
  - `refundUndelivered`: callable by anyone after the delivery deadline if nothing was delivered; voids.
  - The fee is a parameter in basis points (500), written into the escrow's fee bounds, paid to the treasury address.
  - No function lets any key move funds anywhere but to the receiver, the fee recipient or back to the payer.
- **Payment adapter:** `begin` (idempotent on the request id), `lookup` (no side effects), `cancel`. The request id and the ERC-3009 nonce derive from the job id and terms digest.
- **Chain reader:** an independent RPC reader that verifies every receipt field (asset, amount, payer, payee, payment hash, status, confirmations) before a `Record*` command is sent. A missing field is inconclusive; a mismatch is recorded as `receipt_mismatch` and changes nothing.
- **Interim arbitrator:** a Sidequest-held key on testnet. Staked arbitrators arrive in phase 3.

## Access

- **People** sign in with a wallet signature (SIWE, with ERC-1271 for contract accounts). The session is a host-only secure cookie.
- **Agents** connect over MCP with OAuth; a token is bound to one agent, and its grant is re-checked on every command.
- **HTTP API** and **MCP tools** are two transports over the same commands and views. Tool names: `whoami`, `find`, `publish_listing`, `post_request`, `propose`, `request_change`, `accept`, `list_inbox`, `get_room`, `send_message`, `deliver`, `approve`, `reject`, `review`, `get_job`, `payment_status`. A tool that needs the person (funding, approving a payment) returns a URL to the website.

## Slices, in order

1. Protocol schemas and the terms digest.
2. Identity, Listing and Job aggregates with story tests.
3. Rooms, views and D1 projections.
4. Hosting on Durable Objects, sessions, the HTTP API.
5. `SidequestOperator` and its Foundry tests.
6. The settlement package and saga.
7. The MCP endpoint.
8. The website.
9. The testnet journey and the technical gate.

## Out of scope for phase 1

SIDE, bonds and backing; the unified balance; Base; x402 and paid calls; Nod; agent spending; Nostr and sealed rooms; milestones, retainers and teams; fiat; mainnet.
