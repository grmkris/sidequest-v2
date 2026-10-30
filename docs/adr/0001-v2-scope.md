---
status: accepted
date: 2026-10-30
---

# V2 scope: two settlement chains, two payment rails, Sidequest-hosted rooms

Sidequest V2 keeps Sidequest as the coordination and escrow protocol, with Nod as its first-class embedded wallet and every other wallet as an external provider. On 30 October 2026 Kris decided V2's chain, bond, wallet, payment and conversation scope, after local spikes on payment boundaries and Nostr rooms. This record is the engineering summary; the private planning note (Nod × Sidequest, revision 3) holds the research and evidence.

## Decisions

1. **Settlement.** V2 ports the V1 contract suite (`SidequestHolding`, `SidequestEvaluator`, `StakeVault`, `FeeSchedule` and the vendored ERC-8183 core) with V1-compatible interfaces, events and escrow, bond, arbitration, release, refund and owed-payout semantics. It deploys fresh instances on **Monad and Base**. V1 stays live on Monad during migration. Each job settles on exactly one chain; cross-chain escrow is never a property of a job.
2. **Bonds.** Bonds stay SIDE-only (V1 ADR-0010). Canonical SIDE stays on Monad and reaches Base through a Monad locking hub with remote mint/burn peers. Wormhole NTT is the first test route, with LayerZero's OFT Adapter as the comparison. Base escrow opens to users only after a verified bridge round trip, an operating budget and a Base liquidity plan.
3. **Payment rails.** An Agreement records its payment mode:
   - `direct`: an external wallet pays USDC with EIP-3009 `transferWithAuthorization`. The nonce is derived from the payment request and `validBefore` is the approval deadline. There is no on-chain recourse, so review is feedback only.
   - `escrow`: the V2 contracts.

   Both sit behind one adapter interface: `begin` (idempotent), `lookup` (no side effects), `cancel`. Direct pay ships first on Base testnet while the port proceeds. The vertical switches to escrow when the contracts, and for Base the bridge, are ready.

4. **Receipts.** Sidequest re-verifies every provider receipt field against its own chain reader. A missing field is `inconclusive`; a mismatch is `receipt_mismatch`, never success.
5. **Assets.** Amounts are integers in atomic units with an `AssetRef` (issuer, decimals, address, network, canonical id). Networks use CAIP-2-style references. Nothing converts implicitly between assets or precisions (EVM USDC has 6 decimals, Stellar USDC 7).
6. **Nod.** Nod is Sidequest V2's first-class embedded wallet, replacing V1's Privy/Monad wallet flows (commit `f318a22`). It also stays a standalone wallet product with its own app.
   - **Same monorepo:** Nod is ported here from `~/code/hack-meridian-2026` so both iterate together, under its own feature-port plan. trynod.si stays live until the cutover.
   - **One-way dependency:** Nod's packages never import Sidequest packages. Sidequest's settlement core reaches Nod only through the payment adapter interface, so plain external wallets keep working.
   - **No trust in Nod receipts:** Sidequest never treats a Nod receipt as final.
   - **EVM first:** Nod is Stellar-only today, so the Nod adapter for Monad and Base waits for Nod's EVM milestone.
7. **x402.** Sidequest hosts the x402 seller route for fixed-price service cards, with `payTo` set to the agent's wallet. A paid call never funds or activates a job.
8. **Rooms.**
   - Sidequest hosts Nostr-shaped rooms: NIP-17 messages plus a Sidequest room layer for membership, ACL and cursor.
   - The database is the authority; a relay is only a transport cache.
   - Rooms are hosted by default (Sidequest can read them) and sealed (end-to-end) on request.
   - Turn and rate limits are enforced on the server.
   - A message never amends an Agreement, and a Nostr key never authorizes a payment.

## Superseded positions

- **"One settlement chain until there is demand"** (V1-era planning). Its demand conditions now gate opening Base to users rather than deploying there.
- **"No native chat; agents use their own channels"** (V1 iteration scope).
- **The 30 October revision 2 plan's "Nod hosts rooms and the x402 server".**
- **V1's Privy-managed hosted agent wallets** (V1 ADR-0013) do not come to V2. Agents' bounded spend comes from Nod delegations or the agent's own wallet.

## Open

- **Identity and key custody** for room participants. The current lean is a two-key design: a Nod identity certifies client-held device keys. It is provisional until a dedicated spike decides.
- **EIP-3009 gas:** who relays the authorization and pays gas, and `minConfirmations` on Base.
- **Caps:** per-payment or rolling `pay` caps, totalled across networks.
- **V2 MCP tool names.**
- **EIP-712 domain version** for V2 deployments.
- **Audits:** the V2 contract and bridge audit plan.
- **Nod on EVM:** the account model (EIP-7702 delegation, ERC-4337 smart account or a policy-engine provider) and the policy engine.

## Consequences

- A Foundry `contracts/` workspace, server-only settlement packages and Nod's app and packages will appear. Chain adapters stay outside the browser graph (`AGENTS.md`), and `tools/quality/graph.ts` gains their dependency directions, including "Nod never imports Sidequest".
- `docs/FEATURE-PORT-PLAN.md` sequences the work. Contracts may not be ported until Kris accepts it.
