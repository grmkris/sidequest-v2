---
status: proposed
date: 2026-10-30
---

# Feature-port plan

`AGENTS.md` forbids porting V1 business logic, contracts, wallet flows or production data until the foundation gates pass and a feature-port plan is accepted. The gates pass. This is the plan; it becomes binding when Kris marks it `accepted`. Scope and reasons are in [ADR-0001](adr/0001-v2-scope.md).

Evidence levels: **local** (fakes or a local relay), **fork**, **testnet**, **mainnet**. Every gate below names its level. Mainnet steps need Kris's explicit approval.

## Before the first slice

Close the foundation gaps recorded in [REALITY-CHECK.md](REALITY-CHECK.md):

- a real native Workerd and Chromium acceptance test;
- serving the typed `SidequestApi`;
- release flags in the rendered page;
- shared Alchemy state for CI deploys;
- D1 migrations;
- wiring or removing `packages/auth`.

## Tracks

The tracks run in parallel where their dependencies allow.

### A. Direct pay on Base

**Scope:**

- Protocol schemas in `packages/protocol`: WorkRequest, Proposal, Agreement (with payment mode), PaymentIntent, Receipt, AssetRef, NetworkRef.
- A job aggregate in `packages/domain`.
- A server-only settlement package containing:
  - the `begin / lookup / cancel` adapter interface;
  - the EIP-3009 direct adapter, with a request-derived nonce and `validBefore` set to the approval deadline;
  - an independent Base chain reader.
- Operation persistence in `packages/db`.
- External-wallet signing in `apps/web`.

**Gate (testnet):** a verified receipt on Base Sepolia. A retry and a lost response must still produce exactly one transfer.

### B. Contract port

**Scope:**

- The V1 suite in a Foundry `contracts/` workspace, interfaces and events unchanged.
- ERC-8004 registries and the vendored ERC-8183 core for Base.
- Fresh Monad and Base deployments rehearsed on local forks, using V1's R7 mainnet-fork rehearsal as the template.

**Gate (fork):** rehearsal evidence for both chains and an audit plan.

### C. SIDE bridge

**Scope:**

- A Monad locking hub with remote mint/burn peers.
- Wormhole NTT as the first two-way route, with LayerZero's OFT Adapter as the comparison.
- Rate limits and a pause path.

**Gate (testnet):** a verified round trip. Base escrow opens to users only after that, an operating budget and a Base liquidity plan.

### D. Nod

1. **Port Nod into this monorepo** from `~/code/hack-meridian-2026` as its own app and packages. Nod packages never import Sidequest packages.
   **Gate (testnet):** Nod's own acceptance suite passes here. trynod.si stays live on the old deployment until a cutover Kris approves.
2. **Nod on EVM:** an EVM account under the same passkey, an EVM spend-policy model, EIP-3009 intents, 6- and 7-decimal assets side by side, and a cancel step.
   **Gate (testnet):** track A's journey, paid from a Nod account.
3. **Embed Nod in Sidequest** as the first-class wallet through the adapter interface; external wallets keep working.
   **Gate (testnet):** one job paid and one escrow funded from the embedded wallet.

### E. Rooms and identity

**Scope:**

- A key-custody spike first: two-key lean, provisional.
- Then Nostr-shaped rooms: NIP-17 messages plus a room layer, the database as authority and a relay as transport cache.
- Hosted by default, sealed on request.
- Server-side turn and rate limits.
- MCP doorbells.

**Gate (local, then testnet):** the spike's acceptance tests:

- neither Nod nor Sidequest can read a sealed message;
- a revocation lands before the next message;
- a new device is visible to room members.

### F. x402 seller route

**Scope:** Sidequest serves the 402 resource from a signed service card, with `payTo` set to the agent's wallet.

**Gate (testnet):** a paid call whose receipt never marks a job funded.

### G. Stellar settlement adapter

**Scope:** Nod-backed, with its own asset precision and signer rules.

**Gate (testnet):** one full job lifecycle with escrow, review, dispute and bond semantics equivalent to the EVM suite. It is not called multichain settlement before this passes.

## Switching the vertical to escrow

When track B is ready on a chain, and track C for Base, track A's vertical moves from `direct` to `escrow` without changing the work protocol.

## Not ported

- V1's Privy-managed hosted agent wallets and relay paths (V1 ADR-0013, ADR-0023).
- V1 production data.
- Live wallet material.
