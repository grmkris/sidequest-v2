---
status: accepted
date: 2026-11-13
---

# Roadmap

This is the feature-port plan `AGENTS.md` requires. Kris accepted it on 13 November 2026. Scope decisions are in [ADR-0001](adr/0001-v2-scope.md), [ADR-0002](adr/0002-usdc-chains-and-escrow.md) and [ADR-0003](adr/0003-nostr-native.md).

Evidence levels: **local**, **testnet**, **mainnet**. Mainnet steps need Kris's explicit approval.

## Rules for every slice

- One slice at a time on `main`, each ending in a passing `bun run check` and `bun run gate:rehearse` (the phase 2 gate, on a local chain).
- A slice that adds the Nostr path deletes the server-side part it replaces.
- Logic is pure and specified by story tests first. No lint or type suppressions, no code for a later slice, no new dependency without a decision record.
- Pinned beta dependencies are upgraded only in their own commits.

## Done

- **Phase 0, foundation.** A real acceptance test in workerd and Chromium, the typed API, preview deploys.
- **Phase 1, the first complete hire, server-authoritative.** The escrow operator contract on Arc testnet, settlement, the website, the MCP endpoint. Its technical gate passed on Arc testnet for three of four cases; see [STATUS.md](STATUS.md). [PHASE-1.md](PHASE-1.md) describes what was built. Phase 2 replaced its accounts, jobs, rooms and inbox, and its code is deleted.

## Phase 2 — Nostr-native

[PHASE-2.md](PHASE-2.md) describes it as built. Slices 0 to 6 and 8 to 15 are done, and slice 16's evidence disclosure, and with them every deletion in the table: wallet sign-in, sessions, the phase 1 model and its Durable Objects, the core's MCP, OAuth and agent tokens, server rooms and the server inbox left the codebase together, once nothing used them (the order changed in one way: what adds was built first, so every commit kept a working hire). The technical gate has passed on Arc testnet for four of five cases.

| #   | Adds                                                                                       | Deletes                                 |
| :-- | :----------------------------------------------------------------------------------------- | :-------------------------------------- |
| 0   | Loud, patient test waits; this roadmap; ADR-0003                                           | —                                       |
| 1   | The room-protocol spike: rooms use NIP-17 ([ADR-0004](adr/0004-rooms-on-nip-17.md))        | —                                       |
| 2   | `packages/nostr`: events, signatures, encryption, the Sidequest event kinds                | —                                       |
| 3   | Ids become event ids and public keys                                                       | Minted ids                              |
| 4   | The index: tables, validation, accepting signed events, the relay poller, the outbox       | Account names                           |
| 5   | Browser signers and the wallet link                                                        | Wallet sign-in, sessions, wallet claims |
| 6   | The relay pipe on the edge                                                                 | —                                       |
| 7   | Passkey-derived keys                                                                       | —                                       |
| 8   | The agent gateway: MCP and OAuth move out, per-agent keys, grant events                    | Agents and tokens in the core           |
| 9   | Listings as NIP-99 events                                                                  | The listing aggregate                   |
| 10  | The job as a pure fold over events and chain logs                                          | —                                       |
| 11  | Negotiation on events: request, proposal, accept, statement                                | Negotiation commands and views          |
| 12  | Settlement from chain facts; escrow endpoints without sessions; delivery notes and reviews | The job aggregate                       |
| 13  | Operator contract v2 with delegated delivery, redeployed on Arc testnet                    | Operator v1 usage                       |
| 14  | Encrypted rooms behind one transport interface; private proposals                          | Server rooms                            |
| 15  | The inbox in the client                                                                    | The server inbox                        |
| 16  | Evidence disclosure and arbitration                                                        | Session-based rulings                   |
| 17  | Remote signers (NIP-46), reputation output, re-index tooling                               | Remaining shims                         |

**Technical gate (testnet):** two keys complete an escrowed hire on Arc testnet through signed events, the website and the gateway, including a rejection settled by a ruling, with no session and no server-held chat.

**Left in phase 2:**

- **Passkey-derived keys** (slice 7): built ([ADR-0005](adr/0005-domains-and-passkey-scope.md)) and proven in Chromium with a virtual authenticator; left is a stage that offers them (the preview on `v2.sidequest.exchange`) and real passkey providers.
- **Arbitration with evidence** (slice 16): the arbitrator reads disclosed room messages (a member's seal and its keys) beside the job's events before ruling; today a ruling is a NIP-98 request by the arbitration key that sees no evidence.
- **Remote signers** (slice 17): NIP-46, so an agent's key can be scoped per action (`sign_event:<kind>`) outside the gateway.
- **Reputation output** (slice 17): reviews and settled outcomes as a public, recomputable record per key.
- **Re-index tooling** (slice 17): rebuilding the index from relays and the chain alone, and labelling facts a deep reorganisation undid.
- **Audit** of `SidequestOperator` v2 before any mainnet.
- **The gates on a deployed stage:** the gateway and settlement deployed, a real MCP client and a real wallet, and the market gate.

**Market gate:** an agent Kris does not operate completes a hire for a request he posted.

## Later phases (proposed)

- Unified-balance funding and payouts; Base as the second chain; x402 paid calls.
- The SIDE stake layer on Monad: backing, bonds, staked arbitrators.
- Nod in this monorepo; spending delegations.
- Milestones, metered work, teams.
- Audits, then mainnet on Arc and Base.

## Not ported

V1's contract suite, its hosted agent wallets, its production data and any live wallet material.
