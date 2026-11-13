---
status: accepted; its narrowing of rooms is superseded by ADR-0003
date: 2026-11-12
---

# USDC on Arc and Base, escrow through an audited contract, SIDE staked on Monad

This record replaces the settlement, bond and chain decisions of [ADR-0001](0001-v2-scope.md). Kris decided these on 10 and 12 November 2026, after research showed that an audited escrow contract already exists and that Circle's cross-chain USDC balance does not cover Monad.

## Decisions

1. **Currency.** USDC is the main currency. Amounts are integers in atomic units with an `AssetRef`; nothing converts implicitly.
2. **Chains.** Jobs settle on **Arc** (the default) and **Base**. Monad holds the SIDE stake layer and can run plain-wallet USDC jobs later. A job never spans chains.
3. **Escrow.** USDC escrow uses Coinbase's audited `AuthCaptureEscrow` v1.1 (`base/commerce-payments`), already deployed on Base, Base Sepolia and Arc testnet. V1's contract suite is **not ported**, and SIDE is **not bridged**.
4. **Operator contract.** A small `SidequestOperator` contract is the escrow's operator. It enforces the rules on chain, so no server key has discretion:
   - the worker posts the delivery hash on chain;
   - after the review window with no rejection, anyone can trigger capture;
   - a rejection needs the buyer's signature;
   - a disputed job settles only on an arbitrator's signed ruling (EIP-712);
   - the escrow's expiry must be at least delivery deadline + review + dispute + arbitration + margin, so a buyer's reclaim can never pre-empt a job still being settled.
5. **Stake layer.** SIDE stays on Monad. Bonds are reserved there and released or slashed by the same signed ruling that settles the escrow, so no bridge carries messages.
6. **Fees.** One flat fee on escrowed work (5%, a parameter), paid in USDC and written into the escrow at accept time. SIDE backing discounts it. Paid calls and direct payments carry no fee.
7. **Unified balance.** Circle Gateway is the cross-chain USDC balance, added after the first hire works with plain wallet USDC. Agents never receive Gateway delegate rights, and burn intents are signed only at the moment of spending.
8. **Payment rails.** Escrow for agreed deliverables; x402 for fixed-price and metered calls; a direct transfer for trusted work. A paid call never funds a job.

## Changes to ADR-0001

- Decisions 1–3 there (port the V1 suite to Monad and Base, bridge SIDE, direct pay first) are superseded.
- Decision 8 is narrowed: hosted rooms are ordinary server-side rooms with no Nostr in the first phases. Proposals and accepts are typed commands bound by a terms digest. Signed Nostr events and sealed rooms are a later layer.
- Decisions 4–7 (receipt verification, assets, Nod, the x402 seller route) stand.

## Consequences

- The contracts to write and audit are `SidequestOperator` and, later, a bond controller on Monad.
- Contracts live in a Foundry workspace with their own CI job.
- Search, listings and inboxes are D1 projections; aggregates are Durable Objects.
