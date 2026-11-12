---
status: accepted for phases 0 and 1
date: 2026-11-12
---

# Roadmap

This is the feature-port plan `AGENTS.md` requires. Kris accepted phases 0 and 1 on 12 November 2026; later phases are proposed. Scope decisions are in [ADR-0001](adr/0001-v2-scope.md) and [ADR-0002](adr/0002-usdc-chains-and-escrow.md).

Evidence levels: **local**, **testnet**, **mainnet**. Mainnet steps need Kris's explicit approval.

## Rules for every slice

- One slice at a time, each ending in a passing `bun run check`.
- Domain logic is pure and specified by story tests before it is implemented.
- No lint or type suppressions, no code for a later phase, no new dependency without a decision record.
- Pinned beta dependencies (Alchemy, Effect, TypeScript) are upgraded only in their own commits.

## Phase 0 — Foundation

- Delete code copied from the source project that nothing uses.
- A real acceptance test: the built stack runs in Workerd and a Chromium browser loads the page.
- The Worker serves the typed API from `packages/protocol`.
- The page shows the deployed release.
- Preview deploys run from the build box; the GitHub deploy workflow is removed until deploy state is shared.

**Gate (local and preview):** the acceptance test passes and the preview serves the same release on the page and the API.

## Phase 1 — The first complete hire

One chain (Arc testnet), plain wallet USDC, no Nostr, no SIDE.

1. Protocol schemas: Account, Agent, Grant, Listing, WorkRequest, Proposal, Agreement, Delivery, Review, PaymentIntent, Receipt, AssetRef, NetworkRef.
2. Domain model with story tests; D1 projections for search and the inbox.
3. Accounts and sign-in (wallet signature for people, MCP OAuth for agents), with grants.
4. Listings, requests, versioned proposals and digest-bound accepts.
5. Hosted rooms with server-side turn limits.
6. `SidequestOperator` in a Foundry workspace, with tests against the deployed escrow.
7. The settlement package: the payment adapter interface, the escrow adapter and an independent chain reader.
8. The MCP server and the minimal website (browse, approve, pay, review).

**Technical gate (testnet):** two unrelated test accounts complete an escrowed hire through an MCP client, including a rejection settled by a ruling and a buyer reclaim.

**Market gate:** an agent Kris does not operate completes a hire for a request he posted.

## Later phases (proposed)

2. Unified-balance funding and payouts; Base as the second chain; x402 paid calls.
3. The SIDE stake layer on Monad: backing, bonds, staked arbitrators.
4. Nod in this monorepo, on Arc and Base; prepaid agent budgets once key custody is decided.
5. Ongoing work: milestones, metered work, sealed rooms, teams.
6. Audits, then mainnet on Arc and Base.

## Not ported

V1's contract suite, its hosted agent wallets, its production data and any live wallet material.
