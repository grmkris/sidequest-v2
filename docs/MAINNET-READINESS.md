---
status: review
date: 2026-11-13
---

# Mainnet readiness

What stands between Sidequest v2 as it runs today (the `preview` stage on Arc testnet, operator v2, test keys on a build box) and a `production` stage that escrows real USDC. Written on 13 November 2026 from the code at `425f486` and its parents, external facts checked the same day. It prepares for mainnet and stops before it: no mainnet key, transaction or deploy was made, and nothing on Cloudflare was changed.

Severity: **blocker** (no real money before it is done), **should** (before the launch caps are lifted, or within the first weeks), **later**. "Fixed" means done in this review with tests; the commits are listed at the end.

This is not legal advice. Section 6 lists questions for a lawyer.

## The ten that matter most

1. **The operator contract is unaudited** (blocker, §1.1). 760 lines that hold every job's money rules, plus new delegated-delivery surface. Coinbase's escrow under it is audited; our operator is not.
2. **The interim arbitrator is one hot key in a Worker secret** that can split any disputed escrow (blocker, §2.2). The contract already accepts a Safe as arbitrator (proven here, §1.4); production must use one, with the server only relaying.
3. **There is no production stage**: one stage, one D1, one relayer, one domain, and deploy state in files on one build box (blocker, §3).
4. **Arc mainnet has no escrow** (blocker for Arc, §4.1). Arc mainnet is live (chain 5042, since 2026-09-16), but Coinbase's `AuthCaptureEscrow` is not deployed there. Base mainnet has the same escrow, byte for byte, at the same address. Launch on Base, or get the escrow deployed on Arc.
5. **No legal footing**: no terms of service, no privacy policy, no sanctions screening, unanswered questions on custody, money transmission and MiCA (blocker, §6).
6. **The gateway secret is the root of every hosted agent key and cannot be rotated** (blocker, §2.4). A rotation design is in §2.4.
7. **Reads that grow with all history** (should, §5.2). Fixed: indexes and query rewrites for the settler, the relayer's reads and the job reads, and a head-of-line block in the settler. Left: the settler and kept-terms scans still walk every payment ever funded; the poller's author scan walks every event.
8. **No moderation and a year-long cache on every event** (blocker for a public launch, §5.6). Fixed: a hide list behind a moderator key, and events are cached for an hour.
9. **Nothing pages anyone** (blocker, §5.5). The logs carry `alert` annotations, but no Logpush, no alert rule and no on-call exist. Fixed: a relayer-balance warning every minute and a public health read.
10. **The buyer's reclaim after expiry (case d) has never run on a live chain** (should, §7). It is the escrow's own backstop for every failure above.

## 1. The contract

`contracts/src/SidequestOperator.sol`, Solidity 0.8.28, `via_ir`, 760 lines (about 300 of code). No owner, no admin, no upgrade, no `delegatecall`, no assembly of its own.

### 1.1 Unaudited (blocker)

- **What.** `SidequestOperator` v2 has unit, fuzz, invariant and fork tests (163 Foundry tests pass on 2026-11-13, including both fork suites) but no external review.
- **Why it matters.** It decides every capture and void. A bug in `_settle` (`SidequestOperator.sol:734`) or the funding checks (`:643`) moves or strands real money with no upgrade path.
- **Fix.** An audit with the scope in §1.8, before any mainnet deploy. Redeploy is the only fix after deploy (§1.7).

### 1.2 The delegated-delivery surface (should be in the audit)

- **What.** `deliverDelegated` (`:388`) and `revokeDeliveryDelegate` (`:427`): a receiver lets another EOA record one payment's delivery.
- **Why.** It is the newest code. Its worst case, by design, is a junk delivery hash recorded early by a stolen delegate key. The payer's review window and rejection cover that, the same way they cover a junk delivery by the receiver. Revocation can be front-run by a delegated delivery already in the mempool (`contracts/README.md`, "Known limits").
- **Fix.** Name it explicitly in the audit scope. No change proposed.

### 1.3 Immutables: what can never change after deploy

- **What.** `ESCROW`, `COLLECTOR`, `FEE_BPS`, `FEE_RECEIVER` (`:141`–`:150`), the EIP-712 domain (`"SidequestOperator"`, `"1"`), `MARGIN` (1 day), the window bounds (review and dispute 1 h–14 d, arbitration 12 h–14 d) and `MAX_FEE_BPS` (20 %).
- **Why.** Changing the fee, the treasury or any bound means a new deployment at a new address. Jobs already funded stay on the old one until they settle. A **blocked treasury** (USDC blocklist) makes every capture of that deployment revert: the escrow pays the fee and the receiver's share in one transaction (`AuthCaptureEscrow.sol:433`–`471`, vendored), so every job degrades to the buyer's refund or reclaim.
- **Fix (decision).** Kris picks the production fee (500 bps today) and a treasury **Safe** before deploy. The deploy script now refuses a key as treasury on any chain that is not a test network (`TreasuryNotAContract`, fixed).

### 1.4 The arbitrator: one key, its powers, and a Safe instead

- **What.** The arbitrator is a **per-job** parameter (`JobParams.arbitrator`, `:78`), chosen by the server's quote and signed into the buyer's ERC-3009 nonce. It is not an immutable. Today the server names one Sidequest-held EOA (`SIDEQUEST_ARBITRATOR_ADDRESS`) and signs rulings with its key (`SIDEQUEST_ARBITRATOR_KEY`, a Worker secret).
- **What a holder of that key can do**, proven from the contract: on a job in `Disputed` (the buyer rejected), before `rejectedAt + disputeWindow + arbitrationWindow`, split the escrow between receiver and payer in any proportion (`rule`, `:508`). It cannot send funds anywhere else: captures go to `PaymentInfo.receiver` and the fee receiver, voids go to the payer. It cannot act on a job that is not disputed, and it cannot be the payer or the receiver (`:658`).
  - **Key loss.** Disputed jobs fall through to `settleUnruled`: a full refund to the buyer after the arbitration window. Workers lose disputed work, but no funds are stuck.
  - **Key theft.** The thief can rule every open dispute in favour of whichever party they collude with. This is bounded by what is in dispute at the time, and only during those windows.
  - **Rotation.** New jobs name a new arbitrator from the next quote, with no redeploy. The old key must be kept, in cold storage, until every dispute that names it is past its window.
- **ERC-1271.** `_requireAuthorized` (`:704`) accepts a direct call from the arbitrator, or `SignatureChecker.isValidSignatureNowCalldata`. For an arbitrator with code, that is an ERC-1271 check. **Proven:** `test/SidequestOperator.safeArbitrator.t.sol` (7 tests, fixed) shows a Safe-style 2-of-3 multisig ruling three ways: by threshold signatures over its wrapped `SafeMessage` hash relayed by anyone, by calling `rule` itself, and by an on-chain signed message with an empty signature. It also shows that one owner, a stranger as second signer, or signatures over the bare digest are refused. Limits: the Safe must be **deployed on the settlement chain** before a job names it (no ERC-6492 for operator actions), and ERC-1271 answers can change over time (revocable).
- **Fix (blocker).** The production arbitrator is a Safe (2-of-3 at least, owners on hardware keys, not on the build box). The server stops holding `SIDEQUEST_ARBITRATOR_KEY` on production. A ruling becomes "the Safe signs; anyone relays" through the existing `rule` path. The server's `/ruling` endpoint either relays a signature it is given (a small API change: accept `signature` in the payload) or is not used. Until then, `SIDEQUEST_ARBITRATOR_KEY` stays optional and unset on production. The deploy now refuses an arbitrator key that is not the arbitrator address's, and a relayer that is the arbitrator (fixed, §2.1).

### 1.5 Pausing and a kill switch

- **What.** There is none, by design (no owner).
- **Why it matters.** A bug found after launch cannot be stopped in the contract.
- **Decision.** Keep the contract ownerless (its whole trust story), and pause **off chain**:
  - Unset `SIDEQUEST_RELAYER_KEY`, or set a launch cap to zero, on the stage. The server then relays nothing and stops quoting, so no new jobs are funded.
  - Funded jobs keep their on-chain exits: deadline calls anyone may send, and the buyer's reclaim.
  - Writing that runbook is a "can do now" item (§8).
  - A contract pause would put a key in charge of every escrow, which is exactly what the design avoids. Not recommended.

### 1.6 Token blocklist (USDC)

- **What.** Circle's FiatToken reverts any transfer to or from a blacklisted address (`Blacklistable.sol:50`, `FiatTokenV1.sol:267`–`293`, `FiatTokenV2.sol:134`–`144`, `circlefin/stablecoin-evm`).
- **Effect here.**
  - **Blocked receiver or treasury.** `approve`, `settleAfterReview` and a ruling with a worker share all revert. The job sits in `Delivered` or `Disputed` until the buyer reclaims after `authorizationExpiry`. The settler then logs `reverted` each run, then gives up (§5.2).
  - **Blocked payer.** `fund` fails, because ERC-3009 checks `from`. On a funded job, `void` and `reclaim` revert, so the funds wait in the operator's token store.
  - Arc's docs say native-USDC value transfers to blocklisted addresses revert at runtime. The ERC-20 path on Arc was not separately verified.
- **Fix.** Accept it; it is Circle's control. Screen at the relayer (§6.3) so Sidequest does not pay gas for a payment that cannot settle. Put the treasury behind a Safe that can never be blocked for its own actions.

### 1.7 Upgrade story

- **What.** There is none: redeploy and use a new address.
- **How a stage moves.** Deploy a new operator, then set `SIDEQUEST_OPERATOR_ADDRESS` and `SIDEQUEST_OPERATOR_DEPLOY_BLOCK` and redeploy the stage. Old jobs need the old operator for their deadline calls, but the settler serves only the configured operator.
- **Fix (should).** Make settlement read a list of operators: the current one for new quotes, and older ones for deadline calls and the chain log poller until their jobs end. Today a redeploy of the operator orphans the old jobs' settler calls. They fall back to "anyone may call" and the buyer's reclaim, which is safe but slow.

### 1.8 Audit scope, to send to an auditor

| Item           | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| :------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In scope       | `contracts/src/SidequestOperator.sol` (760 lines, about 300 of code), and `contracts/script/DeploySidequestOperator.s.sol` (deploy guards).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Context only   | Coinbase `commerce-payments` v1.1.0 (`AuthCaptureEscrow`, `ERC3009PaymentCollector`, `TokenStore`) at commit `6b0a5ef`, audited by Coinbase Protocol Security and Spearbit/Cantina (v1.1.0: Spearbit, 2026-07-22). OpenZeppelin 5.7.0 `EIP712`, `SignatureChecker`, `ReentrancyGuardTransient`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Spec           | `contracts/README.md` (trust statement, state machine, signatures, fees and rounding, known limits), `docs/adr/0002-usdc-chains-and-escrow.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Invariants     | (1) Funds leave escrow only to `receiver`, `FEE_RECEIVER` or `payer`. (2) A job reaches `Settled` at most once, with exactly one outcome; statuses only move forward. (3) `captured + refunded == maxAmount`; `fee == floor(captured × FEE_BPS / 10 000)`. (4) Every signature takes effect at most once, on one job, one deployment, one chain (no nonces: the uniqueness of `paymentInfoHash` plus status gating). (5) `authorizationExpiry` lies after every window plus `MARGIN`, so `reclaim` never pre-empts a live window. (6) No party but the named one can approve, reject, deliver or rule; deadline calls are permissionless only after their deadline. (7) A delegation is usable only for its payment, before its expiry, before the delivery deadline, and unless revoked by the receiver. |
| Known risks    | Delegated delivery (new). ERC-1271 parties (a revocable answer; a contract wallet calling itself). Blocklisted receiver, treasury or payer (§1.6). Liveness of `settleAfterReview` before expiry (`README`, "Liveness"). Any ERC-3009 token is accepted, so the server must check it is USDC. Rounding dust goes to the payer. Block timestamp skew against windows of hours.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Tests to reuse | `forge test`: unit, fuzz, invariant (`fail_on_revert`), the fork tests (`ArcTestnet`, `BaseMainnet`), coverage with `--ir-minimum`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Deliverable    | Findings by severity; a re-review of fixes; a statement naming the reviewed commit and the deployed bytecode's hash.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

**Routes, rough effort (no prices invented):**

- **(a) A boutique firm** reviewing a small contract on top of an audited dependency: on the order of one to two auditor-weeks plus a fix review.
- **(b) A competitive audit** (Code4rena, Sherlock, Cantina): broader eyes, about one to two weeks of contest plus judging. Better value once the code is frozen.
- **(c) The firm that audited commerce-payments** (Spearbit/Cantina): they know the escrow's semantics, so they ramp up fastest.
- **(d) Before any of these:** an independent second-opinion read and a formal spec of the invariants above (Certora or Halmos rules for invariants 1–3) are cheap and make any route faster.

Recommendation: (d) now, then (a) or (c). Keep a bug bounty for after launch.

## 2. Keys and custody

### 2.1 Relayer key (hot)

- **Where.** `SIDEQUEST_RELAYER_KEY`, bound as a Worker secret from the deploying shell (`Settlement/SettlementStage.ts`). It is readable by the Worker, by anyone with Workers secret-write rights on the account (they can replace it, not read it), and by whoever holds the shell's file.
- **What it can do, from the code.** The relayer signs only two things (`packages/settlement/src/Relayer.ts:188`–`189`): calls **to the operator**, and zero-value transfers **to itself** (nonce releases). **From the contract:** no function grants `msg.sender` any role except the named party (`_requireAuthorized`, `:704`; `_requireDelegateSigned`, `:713`). So a relayer that is not a party can only submit calls whose authority is someone else's signature, or deadline calls anyone may send.
- **Its powers are therefore:** pay gas; choose whether and when to submit (censorship or delay, bounded by the permissionless paths and the buyer's reclaim); and, if it were also the arbitrator, rule. That last case is now refused at deploy and by the Worker (fixed).
- **Theft.** The thief drains the gas balance. Keep the balance small (a day or two of gas) and top it up from the treasury Safe.
- **Fix.** Production gets its own relayer key, distinct from the preview's (§3). Its balance is now visible (`GET /api/status/settlement`, fixed) and warned on below a threshold every minute (`Sidequest.Settlement.relayerBalanceLow`, fixed). A daily gas budget is a launch cap (fixed, §7).

### 2.2 Arbitrator key: see §1.4 (blocker: a Safe on production)

### 2.3 Treasury

- **What.** The operator's immutable `FEE_RECEIVER`. Today it is a throwaway test key.
- **Fix (blocker).** A Safe on the settlement chain, deployed before the operator. The deploy script refuses a key there now (fixed).

### 2.4 The gateway secret: the envelope root, with no rotation (blocker)

- **What.** `apps/gateway/src/Keys/KeyEnvelope.ts`. Each hosted agent's key is sealed with its own data key, and each data key is sealed with the gateway secret (a Worker secret). With the secret and a D1 dump, every hosted agent key opens. A row records `version`, but nothing says _which secret_ sealed it.
- **Why.** Leakage of one secret means every agent key, and so every hosted agent's signatures and rooms (§6.4). There is no way to roll it today without making every agent unusable.
- **Rotation design (implement before production):**
  1. Add a `secret_id` column to the sealed-key rows: the first 8 bytes of SHA-256 of the secret, never the secret itself.
  2. Bind `SIDEQUEST_GATEWAY_SECRET` (current) and an optional `SIDEQUEST_GATEWAY_SECRET_PREVIOUS`.
  3. Opening a key tries the secret whose id matches.
  4. A rewrap job (a cron step, bounded per run) opens each data key sealed by the previous secret and seals it again with the current one. Only the 32-byte data keys are re-sealed; agent keys never leave memory.
  5. When no row names the previous id, the stage unbinds the previous secret.
  6. A compromise also means rotating the agents' own keys. Each agent publishes a new key under a new grant, and its operator revokes the old grant. That is a gateway feature (re-key an agent) and needs its own design.
- **Runbook.** Generate the secret in memory and put it straight into `wrangler secret put` (or the Alchemy-bound env var) from a shell that never writes it to disk. Keep the previous secret until the rewrap job reports zero rows left.

### 2.5 Arbitration Nostr key and moderator key

- **What.** `SIDEQUEST_ARBITRATION_PUBKEY` (who may ask for a ruling, NIP-98) and the new `SIDEQUEST_MODERATOR_PUBKEY` (who may change the hide list). Only public keys are bound; the secret keys live with the people who use them.
- **Fix.** Hold them on a NIP-46 remote signer or a hardware-backed signer, never on the build box. Rotation is a redeploy with a new public key. NIP-98 authorizations can be replayed for the same request within their minute (`Escrow/Arbitration.ts`), which is harmless for idempotent requests (ruling, hide, unhide).

### 2.6 Where secrets live; what must change from "throwaway keys in files on a build box"

| Secret                             | Today                                 | Production                                                                                                        |
| :--------------------------------- | :------------------------------------ | :---------------------------------------------------------------------------------------------------------------- |
| Relayer key                        | file on the build box → Worker secret | generated for production only; Worker secret; small balance; budget                                               |
| Arbitrator key                     | file → Worker secret                  | none: a Safe (§1.4)                                                                                               |
| Treasury                           | a test key's address                  | a Safe                                                                                                            |
| Gateway secret                     | file → Worker secret                  | production only; rotation (§2.4)                                                                                  |
| Arbitration / moderator Nostr keys | keys on the build box                 | remote or hardware signer                                                                                         |
| Deployer key (operator deploy)     | `--account` keystore on the build box | hardware wallet (`forge script --ledger`), used once; the operator has no owner                                   |
| RPC URL with a provider key        | public URL, bound as a plain variable | bind as a **secret** (a paid RPC URL embeds its key; plain variables show in the dashboard and in Alchemy's plan) |
| Cloudflare API token (deploys)     | the build box's shell                 | a CI secret with a token scoped to the account's Workers, D1 and DNS, nothing else                                |

Who can read Worker secrets: nobody through the API, since secrets are write-only. Anyone with "Workers Scripts: Edit" on the account can replace them, and can deploy code that prints them. So the Cloudflare account's member list and API tokens are part of custody: enforce 2FA, use scoped tokens, and review members.

## 3. Stage separation

### 3.1 A production stage (blocker)

- **What.** Alchemy stage `production` with its own D1 (core and gateway), relayer, gateway secret, operator, treasury and arbitrator Safe, and its own Cloudflare custom domains. No binding, key or database is shared with `preview`.
- **Fix.** Add `deploy:production` (`alchemy deploy --stage production`) only once the checklist (§8) allows it. The settlement guard already refuses a mainnet chain without the stage's opt-in phrase (fixed).

### 3.2 Domains and the passkey scope (decision)

- **Today.** The preview owns `v2.sidequest.exchange` and `agents.v2.sidequest.exchange`. Passkeys use RP ID `sidequest.exchange` (ADR-0005), which **every subdomain** can use.
- **Risk.** If preview and production both offer passkeys under `sidequest.exchange`, the same passkey derives the **same Nostr key** on both (the PRF input is fixed: `PasskeyKey.ts`, version 1). A person's testnet identity and mainnet identity become one key. Events signed on the preview (and its looser, unaudited code) are valid on production, because events are global. A script injected into the preview can derive production keys.
- **Recommendation.**
  - Production takes `sidequest.exchange` itself, or keeps `v2.sidequest.exchange` once v1 retires. The gateway goes on `agents.sidequest.exchange`.
  - **The preview moves to a different registrable domain**, for example a separate zone such as `sidequest-preview.dev`. It then gets its own RP ID, so no passkey key is shared and no preview script can reach a production passkey. If the preview must stay under `sidequest.exchange`, set `SIDEQUEST_PASSKEY_RP_ID` unset on the preview (no passkeys there).
  - Retire v1 at the apex, or treat it as able to sign as every passkey user (ADR-0005 consequence).
- **Decision for Kris.** The production hostname, and the preview's new zone.

### 3.3 Deploy state on one box (blocker)

- **What.** `alchemy.run.ts:12` uses `Alchemy.localState()` (`.alchemy/state` on the build box, git-ignored). Lose the box and you lose the record of what the stage owns. Only that box can deploy.
- **Options in the pinned Alchemy** (2.0.0-beta.84, read from `node_modules`):
  - `@alchemy.run/cloudflare/StateStore` `state({ name })`: a Worker `alchemy-state-store` with a Durable Object, values AES-CTR encrypted with a key in Cloudflare Secrets Store, and a bearer token.
  - `makeHttpStateStore` (`alchemy/State`): any HTTP backend.
  - `makeBucketState`: a lease-locked bucket base, with no R2 implementation shipped.
  - There is no D1 or R2 state store.
- **Recommendation.** `Cloudflare.state({ name: 'sidequest' })` for both stages. It creates Cloudflare resources, so it needs Kris's go-ahead and was not done here. Migrate by importing the current local state once, from the build box, then deploying from CI only.

### 3.4 CI/CD gates for production (should)

- Production deploys only from CI on a tagged commit of `main`. The commit must have passed `bun run check`, `gate:rehearse` (Anvil), the contracts workflow and a `gate:rehearse` against the preview.
- Use a GitHub environment `production` with required reviewers (Kris), and a Cloudflare token scoped to that account.
- The deploy step sets `SIDEQUEST_ALLOW_MAINNET` from the environment. Nobody types it in a shell.
- Migrations run before the Worker version that needs them. Every migration must be additive, or have a rollback note.

### 3.5 Rollback (should)

- **Workers.** `wrangler rollback` / version pinning reverts code, not D1.
- **D1.** Time Travel restores to a point in time (check the retention on the account's plan). Record the bookmark before every production migration.
- **Contract.** There is no rollback. A bad operator is replaced for new jobs (§1.7), and its old jobs settle by their own rules.

## 4. Chain configuration

### 4.1 External facts (checked 2026-11-13)

| Fact                                                                                                                                                                                                                                               | Source                                                                                                                                          |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------- |
| Arc mainnet is live since 2026-09-16, chain id **5042**, RPC `https://rpc.mainnet.arc.io`, explorer `explorer.arc.io`, USDC is the gas token (18 native decimals), mempool fee floor 20 gwei                                                       | circle.com press release "Circle launches Arc mainnet"; docs.arc.io/arc/references/connect-to-arc; `cast chain-id`, block 31064133 at 17:19 UTC |
| Arc mainnet USDC `0x3600…0000`, 6 decimals, EIP-712 `"USDC"` / `"2"`, separator `0x9405…df84` (recomputed)                                                                                                                                         | docs.arc.io/arc/references/contract-addresses; `cast call`                                                                                      |
| **No** commerce-payments contracts on Arc mainnet: no code at `0xf968…B19c`, `0x8612…ab88` or the token store `0xe4be…D450`                                                                                                                        | `eth_getCode` on rpc.mainnet.arc.io                                                                                                             |
| Base mainnet `AuthCaptureEscrow` v1.1.0 `0xf96815976523E00e65Be8f34cA5e64b4f41EB19c`, `ERC3009PaymentCollector` `0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88`, the same addresses as Base Sepolia and Arc testnet (CREATE2)                         | github.com/base/commerce-payments README (the vendored v1.1.0 tag's README still lists v1.0.0 addresses: do not copy from it)                   |
| Base mainnet runtime bytecode equals Arc testnet's and Base Sepolia's (escrow keccak `0x3355…702a`, collector `0xe273…b62f`, token store `0x8ff3…600a`), and equals the vendored v1.1.0 build after masking metadata and immutables                | `contracts/test/fork/BaseMainnet.fork.t.sol` (added here), passed against `https://mainnet.base.org`                                            |
| USDC domains: Base mainnet `0x8335…2913` **"USD Coin"** / "2"; Base Sepolia `0x036C…CF7e` "USDC" / "2"; Arc testnet "USDC" / "2" (matches the repo); Ethereum `0xA0b8…eB48` "USD Coin" / "2". `eip712Domain()` reverts on all, so pin them by hand | `cast call name()/version()/DOMAIN_SEPARATOR()`, each recomputed                                                                                |
| commerce-payments audits: Coinbase Protocol Security (2025-03-19, 03-26, 04-15), Spearbit/Cantina (2025-04-01, 04-22), Spearbit on v1.1.0 (2026-07-22; not in the vendored tag)                                                                    | github.com/base/commerce-payments/tree/main/audits                                                                                              |

### 4.2 Everything hard-coded to Arc testnet today

- `packages/protocol/src/AssetRegistry.ts`: `UsdcOnArcTestnet`, the only registered asset. Listings and terms accept only it.
- `packages/settlement/src/SettlementChain.ts`: `arcTestnet()`, chain 5042002, its escrow, collector and USDC domain.
- `packages/server/src/Settlement/ArcRpc.ts`: `arcTestnetRpcUrl`, the service name `ArcRpc` and the variable `SIDEQUEST_ARC_RPC_URL`.
- `packages/server/src/Stack.ts`: the default RPC.
- `apps/web/src/Chain.ts`: the wallet's chain (id, name, RPC `rpc.testnet.arc.io`) for `wallet_addEthereumChain`.
- `apps/web/src/page/job/Propose.ts` and `apps/web/src/page/ListingForm.ts`: `UsdcOnArcTestnet` for amounts and decimals.
- The `money.wrongChain` copy says "Arc testnet".
- `contracts/script/DeploySidequestOperator.s.sol`: the canonical addresses.
- `contracts/test/fork/ArcTestnet.fork.t.sol`.
- The rehearsals: `packages/server/rehearsal/*`.
- The index's wallet links: `linkChain` 5042002 in the tests. The identity page links on the wallet's chain.

### 4.3 Per-stage chain design (implemented for the server; refused for mainnets)

- **One chain per stage** (recommended). A stage's escrow, relayer nonce sequence, chain log poller, settler and quotes all assume one chain. Multi-chain in one stage would need a chain key on every intent, cursor and quote, and `chain_facts.chain` exists but no read filters on it. Two production stages (`production-base`, later `production-arc`) can share a domain plan through a router, or keep separate subdomains.
- **Implemented** (`packages/settlement/src/Chains.ts`, `Settlement/SettlementConfig.ts`, fixed):
  - `SIDEQUEST_CHAIN` names a profile: `arc-testnet` (the default, which builds exactly today's chain), `arc-mainnet` or `base-mainnet`.
  - Each profile holds the chain id, a `mainnet` flag, the USDC asset and its EIP-712 domain, the commerce-payments addresses where deployed (none on Arc mainnet), default confirmations (3 on Arc, 10 on Base), the public RPC and a low-balance threshold.
  - **A mainnet is refused** at deploy, and again by the Worker, unless `SIDEQUEST_ALLOW_MAINNET` is exactly `settle real money on <chain> (chain <id>)`. Two independent keys: the chain choice and the phrase.
  - Arc mainnet is refused even with the phrase (`EscrowNotDeployed`).
  - `stageRpcUrl` defaults to the named chain's public RPC.
  - The deploy script got the same kind of guard: a separate, exact `SIDEQUEST_ALLOW_MAINNET_DEPLOY` phrase per chain id, and a dry run that prints the plan (fixed).
- **Not yet** (should, before a mainnet stage):
  - Register Base USDC in the protocol's asset registry, but only for a stage on Base. The registry is static today, so listings would accept it everywhere; it must become stage-aware.
  - The website's chain (`apps/web/src/Chain.ts`) from the stage, not a constant.
  - **RPC.** A paid provider as primary, bound as a secret, with a fallback (viem `fallback([http(primary), http(secondary)])`). The relayer must read nonces from one node at a time, because a lagging fallback node makes a used nonce look free; so the relayer keeps a single transport and only reads fail over.
  - `SIDEQUEST_OPERATOR_DEPLOY_BLOCK` required on mainnet.
  - Confirmations per chain: Base's 10 is a starting point. Use its finalized tag where the RPC offers it.

## 5. Server

### 5.1 Rate limits → Cloudflare rules (should)

- **Today.**
  - D1 fixed windows: publish 120/min per IP and 30/min per key (`Index/PublishLimits.ts`); escrow 30/min per IP (`Http/EscrowHttp.ts`); MCP per agent.
  - The relay pipe's bounds (32 open, 30-burst per address) are per isolate (`RelayPipe/PipeAdmission.ts`), so on Cloudflare each isolate counts alone.
  - The gateway's OAuth endpoints are unlimited.
- **Add, as WAF rate-limiting rules on the zone** (by `ip.src`, action block for 60 s):

| Rule                                                                                       | Rate                    |
| :----------------------------------------------------------------------------------------- | :---------------------- |
| `http.request.uri.path eq "/api/events" and http.request.method eq "POST"`                 | 120 per 60 s            |
| `starts_with(http.request.uri.path, "/api/index/jobs/") and http.request.method eq "POST"` | 30 per 60 s             |
| `http.request.uri.path eq "/relay"` (WebSocket upgrades)                                   | 30 per 60 s             |
| `http.host eq "<gateway host>" and starts_with(http.request.uri.path, "/oauth")`           | 20 per 60 s             |
| `http.host eq "<gateway host>" and http.request.uri.path eq "/register"`                   | 5 per 60 s              |
| `starts_with(http.request.uri.path, "/api/moderation/")` and method not GET                | 10 per 60 s             |
| everything under `/api/`                                                                   | 600 per 60 s (backstop) |

- **Fixed.** The rate-limit table's prune is now an index search. A bucket's first take of a new window deletes its ended windows, so the gateway's table (never pruned, no cron) stays at one row per bucket.

### 5.2 Queries that degrade with volume

Every statement in `packages/server/src`, `packages/serving/src` and `apps/gateway/src` (102) went through `EXPLAIN QUERY PLAN` on SQLite, empty and with synthetic volume (20 000 requests, 80 000 proposals, 5 000 funded payments, 20 000 intents), with and without `ANALYZE`. A fresh D1 has no planner statistics.

| Query                                                               | Before                                                                                  | Fix (migration 0015 unless noted)                                                                                       | State                              |
| :------------------------------------------------------------------ | :-------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------- | :--------------------------------- |
| Settler due query (`Escrow/Settler.ts`), every minute               | `SCAN chain_facts` + temp sort, 47 ms                                                   | partial index `chain_facts_funded`: 4.9 ms                                                                              | fixed                              |
| Settler, payments it gave up on                                     | sorted first: ten given-up payments kept every newer payment out of `duePerRun` forever | given-up payments sort last                                                                                             | fixed                              |
| `relayedReads` (`Escrow/EscrowChain.ts`), per payment, every minute | `instr(id, hash)`: `SCAN relayer_intents`, 9 ms                                         | expression index `relayer_intents_by_payment`, the same expression in the query: 0.08 ms                                | fixed                              |
| Job reads (`Index/JobEvents.ts`, `Escrow/Standing.ts`)              | walk `events_by_kind` (every event of the kind), 60–80 ms per call                      | `+kind`: id lookups, about 0.1 ms                                                                                       | fixed                              |
| Open requests (`Index/Jobs.ts`)                                     | 3.6 s for 5 rows without statistics; a 100-row page did not finish                      | `+s.kind`, `+p.kind`; `events_by_kind (kind, created_at DESC, id)`: 1.2 ms                                              | fixed                              |
| A key's jobs by its agents (`Jobs.ts`)                              | outer loop over every proposal, 1.5 s                                                   | `+p.kind`: 0.15 ms                                                                                                      | fixed                              |
| Outbox due batch                                                    | temp sort                                                                               | partial `outbox_due … WHERE state = 'pending'`                                                                          | fixed                              |
| Kept terms (`Escrow/KeptTerms.ts`), every minute                    | 2.5 s; grows with funded payments × proposals                                           | `chain_facts_funded` helps; needs `CROSS JOIN` order and, better, a kept-marker per payment                             | should                             |
| Settler and kept terms still walk every Funded fact ever            | linear in all payments                                                                  | an `open_payments` projection (insert on Funded, delete on Settled/Reclaimed, rebuilt from `chain_facts`)               | should                             |
| Poller's authors (`Index/EventStore.ts:210`), every 10 min          | `SCAN` + `GROUP BY` over every event, 430–770 ms at 110 000 events                      | a latest-per-author table                                                                                               | should                             |
| Gateway: `used_authorizations` prune, OAuth client cleanup          | `SCAN`, quadratic                                                                       | gateway migration: `used_authorizations (expires_at)`, `oauth_clients (registered_at)`, `oauth_connections (client_id)` | should (gateway, not touched here) |
| Listing search with `q`                                             | `LIKE '%q%'` walks every listing when matches are rare                                  | D1 FTS5 virtual table on title and summary                                                                              | later                              |

**Unbounded tables.**

- Core: `events`, `event_tags`, `chain_facts` and `kept_events` (by design); `outbox` (delivered, refused and abandoned rows are never deleted); `relayer_intents` and `relayer_transactions`.
- Gateway: `oauth_tokens` and revoked `oauth_connections`; expired `delivery_delegations`.

**Retention design for `events`.** A D1 database holds at most 10 GB (Cloudflare's current limit for paid plans; check before relying on it). Keep forever everything a job's fold or a payment needs: requests and proposals named in `kept_events`, every event whose `e` tag names a funded job, wallet links, grants and revocations. Prune:

- unfunded jobs' proposals and statements 180 days after the request expired;
- superseded replaceable events (old profiles, relay lists, listings older than the current `d`);
- `outbox` rows older than 7 days that are no longer pending.

Pruning is a minute cron step that deletes at most N rows per run, always joined against `kept_events` and funded jobs so it never removes what a fold needs. Events stay on public relays, so pruning is not deletion from the network.

### 5.3 Relayer gas exhaustion

- **Fixed.** A warning every minute below the stage's threshold (`SIDEQUEST_RELAYER_LOW_BALANCE_WEI`, defaulting to the chain profile's), and a public health read, `GET /api/status/settlement` (relayer address, balance, threshold, the day's committed gas and the budget; no secrets, never cached).
- **Should.** An alert on that log (§5.5), and a funded-days estimate (balance divided by trailing-7-day spend).

### 5.4 RPC failure modes

- **Today.** One URL; `retryCount` 1 or 2 with a 10 s timeout (`ArcRpc.ts`, `ChainRpc.ts`).
- **Behaviour.** An unreachable RPC makes escrow steps answer 503 (`ChainUnavailable` → `Unavailable`). The settler and poller skip the minute. The relayer's intents survive in D1 and are repaired on the next relay.
- **Risks.** A lagging node can make the relayer think its nonce is unused (handled: `Lost` vs `Stuck` after 120 s). A node that refuses everything leads to releases.
- **The 503 seen once on Arc testnet is still unexplained.** It is not in the recorded evidence (`docs/evidence/*.json` contain no 503 status), so it cannot be traced now.
- **Fix (should).** Log the RPC host and JSON-RPC error code on every `ChainUnavailable`, which `reasonOf` already captures; alert on more than 5 per 10 minutes; use a paid primary RPC.

### 5.5 Observability and alerts (blocker)

- **What exists.** Workers Logs and traces (`observability`, head sampling 1). Logs annotated with `alert`:
  - `settlement-relayer` (`transactionRefused`, `nonceReleased`, `gasBudgetSpent`, `relayerBalanceLow`)
  - `settler` (`settlerSkipped`)
  - index failures (`Sidequest.Index.* failed`)
- **What pages someone.** Nothing.
- **Fix.**
  - Workers Logpush to an alerting sink, or a minute cron that counts `alert` logs. Wire Workers Logs alerts if available on the plan.
  - Telegram is the operator channel already used on this box.
  - Page on: relayer balance low; any `transactionRefused` or `nonceReleased`; `settlerSkipped` with `gaveUp`; an arbitration deadline within 24 h on a disputed job with no ruling (needs a small query: disputed payments by `arbitrationEndsAt`); chain log poller cursor more than 10 minutes behind; D1 `Unavailable` rate.
  - An external uptime check on `/api/status` and `/api/status/settlement`.

### 5.6 Abuse and moderation

- **Spam events.** Publish limits (§5.1), the 64 KiB event cap (`Index/Validation.ts`), and only Sidequest's kinds and a few NIPs are kept. Per-key limits are trivially bypassed with new keys, so the WAF IP limit is the real bound. Later: proof of work (NIP-13) on requests and listings, or a minimum key age.
- **Listing spam and illegal content.** Listings, requests and the rooms' disclosed `/evidence` are public text served from Sidequest's domain, so Sidequest is the host in a takedown sense.
- **Fixed: the hide list** (`Index/Moderation.ts`, `OperationsApi`):
  - `SIDEQUEST_MODERATOR_PUBKEY` (64 hex, a stage setting) is the only key whose NIP-98 authorization may `PUT` or `DELETE /api/moderation/hidden/:target` (`{ kind: 'event' | 'pubkey', reason }`).
  - Anyone may `GET /api/moderation/hidden` (the newest 500, with reasons, for transparency).
  - Hidden events, and every event of a hidden key, drop out of the open requests and the listing search. Reads by id still answer, with the header `sidequest-labels: hidden`.
  - Nothing is deleted from D1 or from relays.
  - An event read by id was cached `public, max-age=31536000, immutable`; it is now `max-age=3600`, so a takedown reaches browser caches within the hour. This is the one behaviour change on the preview.
- **Takedown procedure (to write; can do now).** Receive a notice at a published address. The moderator hides the target with a reason that names the notice, and answers within the time the DSA requires (§6.7). Where the law requires removal rather than hiding, delete the event row and its derived rows by a one-off script that keeps a hash of what was removed.
- **Should.** The website shows the label; the gateway's MCP tools leave hidden listings out (not touched here: other agents own those tools); a block on publishing by a hidden key.

### 5.7 CORS and CSP

- **CORS.** None, by design (`packages/protocol/src/Api.ts`). Nothing ambient is read, so cross-origin requests gain nothing. Keep it until third-party web clients are a product decision.
- **CSP** (`EdgeSecurity.ts`). The documents' policy is strict: `script-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`. The API sends `default-src 'none'`.
- **Should.**
  - Add `upgrade-insecure-requests`, and `report-to` with a reporting endpoint.
  - Keep the gateway's nonce-only CSP.
  - HSTS stays without `includeSubDomains` until the zone's other hosts are known (ADR-0005). With a production apex, revisit `includeSubDomains`, which then protects the passkey scope.

### 5.8 Supply chain and secrets in logs

- **Pinning.** Every dependency is pinned exactly (`bunfig.toml` `exact = true`, `bun.lock`), Foundry dependencies by checksum (`soldeer.lock`), and vendored sources are checked (`vendor:check`, `provenance:check`).
- **The two-week rule** (a version must be at least two weeks old) is a convention, not enforced in the install. Should: enforce a minimum release age in Bun's install settings if the pinned Bun supports it, or in a CI check over `bun.lock`.
- **Secrets in logs.** Keys are `Redacted` from the shell to the Worker binding, and deploy errors name variables, never values (tested). `redactQueryString` is on.
- **Gap.** A paid RPC URL with its key is a plain variable, so it shows in the dashboard and could appear in an error's `reason` (viem's `shortMessage` can include the URL). Bind it as a secret, and strip the URL from `reasonOf`.

## 6. Legal and compliance questions for a lawyer (not legal advice)

1. **Custody.** USDC sits in Coinbase's `AuthCaptureEscrow`; Sidequest's operator contract has no owner. Sidequest's relayer submits calls, and its arbitrator can split disputed funds between the parties. Is Sidequest a custodian, an escrow agent, or a payment service provider, under EU (PSD2/PSD3) and Slovenian law, and in the US (state escrow and money-transmitter laws)? Does a Safe arbitrator held by Sidequest change the answer?
2. **Money transmission.** Does taking a 5 % fee out of a capture make Sidequest a transmitter or a payment institution? Does relaying users' signed transfers?
3. **Sanctions.** Should the relayer screen payer and receiver addresses (OFAC and EU lists, and the on-chain USDC blocklist), and refuse to relay? Screening at the relayer is technically easy: a refusal reason beside the launch caps. The escrow itself cannot be stopped.
4. **Hosted agents.** The gateway holds agents' keys (sealed, but openable by Sidequest with the gateway secret) and can read hosted agents' rooms. That is custody of credentials and access to private messages. What must the terms say, what are Sidequest's obligations on a data request, and is this a "processor" role under GDPR?
5. **Terms of service and privacy policy.** There are none, and nothing records acceptance. The minimum before real money: ToS covering the escrow rules, arbitration, the fee, the launch caps and liability; a privacy policy covering the index, the gateway and logs.
6. **GDPR and a public index of Nostr events.** Events are public and signed, and live on relays outside Sidequest's control. A deletion request: does hiding suffice, must the row be deleted, and what about events `kept_events` must keep for a funded job's terms (a legitimate interest or contract basis)? What about NIP-09 deletion events?
7. **Jurisdiction and EU rules.**
   - Slovenia and the EU: MiCA for the use of USDC (an e-money token: Circle is the issuer, but is Sidequest providing a crypto-asset service, such as custody or transfer?), and for the planned **SIDE** token (an "other" crypto-asset needing a white paper, or exempt?).
   - The Digital Services Act for the index as a hosting service (notice-and-action, a point of contact, transparency).
   - The Travel Rule for transfers Sidequest relays.
8. **Tax and VAT.** VAT on the 5 % fee: the place of supply for B2B and B2C, and whether the OSS scheme applies. Income recognition of USDC fees, and their accounting in a Slovenian entity.
9. **The arbitrator's liability** for a ruling, and whether arbitration needs a published procedure.

## 7. Product gaps before real money

- **Case (d), the buyer's reclaim, never ran live** (should). Run it on Arc testnet with the shortest windows the contract allows (expiry at least 1 day plus windows; about 38 h). Start it now, so it finishes before launch.
- **No real wallet, extension or MCP client proof** (blocker for the market gate): MetaMask or Rabby on the deployed preview, a NIP-07 extension, and claude.ai or ChatGPT over OAuth (STATUS "Not proven").
- **Arbitration with evidence is not built** (blocker if disputes are possible at launch). Today a ruling sees no disclosed evidence. Either build slice 16's evidence view, or run the launch with a published manual procedure: the arbitrator reads the job's events and the disclosed room messages by hand.
- **No ToS acceptance** (blocker): a signed event of a "terms accepted" kind, or a wallet signature over the ToS hash, before the first fund. That is protocol vocabulary, so it was not added here.
- **Launch caps** (fixed, unset on the preview). `SIDEQUEST_CAP_MAX_JOB_AMOUNT` (atomic units), `SIDEQUEST_CAP_ALLOWED_PUBKEYS` (both the buyer and the bidder, the operator for an agent's proposal), and `SIDEQUEST_CAP_DAILY_GAS_WEI` (the gas the relayer committed since 00:00 UTC, counted as gas limit × max fee of every signed transaction). Each refuses before relaying, with `EscrowRefused { reason: 'LaunchCap', detail }`, and the job page says so. The settler's deadline calls are not budgeted, because they protect buyers and are bounded per run.
- **Recommended launch values.** Max job 100 USDC (`100000000`); the allowlist invite-only for the first weeks; a gas budget of three times a normal day's spend on the chosen chain.
- **Incident runbook** (can do now). Contents:
  - pause by unsetting the relayer key or by a zero cap (§1.5);
  - rotate a key (§2);
  - a stuck nonce (`relayer_intents` open, `nonceReleased` logs);
  - RPC down;
  - a blocked receiver (§1.6);
  - a disputed job near its deadline;
  - a takedown (§5.6);
  - D1 restore (§3.5).

## 8. Launch checklist, in order

**Can do now (code and docs, no keys, no Cloudflare changes)**

1. Audit prep: freeze the operator, write the invariant spec (§1.8) and Halmos/Certora rules for invariants 1–3.
2. The gateway secret rotation (§2.4) and the agent re-key feature.
3. Arbitration through a Safe: accept a pre-signed ruling in the `/ruling` payload; make `SIDEQUEST_ARBITRATOR_KEY` absent by design on production.
4. Settlement over several operators (§1.7).
5. A stage-aware asset registry and website chain (§4.3); bind the RPC URL as a secret; strip URLs from RPC errors.
6. The gateway's query indexes and token prunes (§5.2); the `open_payments` projection; the kept-terms rewrite; the events retention job.
7. Alerts: an arbitration-deadline query, a Logpush or cron alert sender, an uptime check (§5.5).
8. A relayer sanctions-screening hook (a refusal beside the launch caps), its list source left to item 17.
9. A ToS-acceptance event, once the vocabulary is agreed.
10. The incident and takedown runbooks.
11. Start case (d) on Arc testnet now.

**Needs Kris**

12. Choose the launch chain: **Base mainnet** (escrow deployed and verified), or wait for commerce-payments on Arc mainnet.
13. Production fee bps and the treasury Safe (owners, threshold); the arbitrator Safe; who holds the moderator and arbitration keys.
14. Domains: the production hostname, the preview's new zone, passkeys on the preview or not (§3.2); v1's apex.
15. Remote deploy state (`Cloudflare.state()`), the CI production environment and the scoped Cloudflare token (§3.3–3.4).
16. Launch caps' values and the invite list.
17. Engage a lawyer with §6; the ToS and privacy policy; a sanctions screening source.
18. Fund the production relayer, and deploy the operator from a hardware wallet with `SIDEQUEST_ALLOW_MAINNET_DEPLOY` after a dry run.

**Needs a third party**

19. The audit (§1.8), and a re-review of fixes.
20. A paid RPC provider (primary and secondary) on the launch chain.
21. Circle or Arc: commerce-payments on Arc mainnet, if Arc is wanted.
22. The lawyer's answers (§6), and a tax adviser for VAT on fees.
23. A real outside agent completing a hire on the preview (the market gate).

## Fixed in this review

| Change                                                                                                                                                                        | Tests                                                                                     |
| :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------- |
| A Safe-style ERC-1271 arbitrator rules three ways; below threshold it cannot (no contract change)                                                                             | `contracts/test/SidequestOperator.safeArbitrator.t.sol` (7)                               |
| The deploy script: a mainnet only with an exact per-chain phrase; a contract treasury off testnets; a dry run                                                                 | `contracts/test/DeploySidequestOperator.t.sol` (5)                                        |
| Base mainnet fork checks: escrow bytecode equals the vendored build; USDC's domain                                                                                            | `contracts/test/fork/BaseMainnet.fork.t.sol` (2, read-only, passed)                       |
| Per-stage chain (`SIDEQUEST_CHAIN`), mainnets refused at deploy and by the Worker without `SIDEQUEST_ALLOW_MAINNET`; key and address agreement; relayer is not the arbitrator | `packages/settlement/test/Chains.test.ts`, `packages/server/test/SettlementStage.test.ts` |
| Launch caps: max job amount, allowlist, daily gas budget                                                                                                                      | `packages/server/test/Escrow.funding.test.ts` ("funding under launch caps")               |
| Migration **0015** (x402 holds 0014): indexes and the hide list; `+kind` rewrites; the relayed reads by expression index                                                                        | the whole server suite; `EXPLAIN QUERY PLAN` (§5.2)                                       |
| The settler's head-of-line block; the relayer-balance warning                                                                                                                 | `packages/server/test/Escrow.settler.test.ts`                                             |
| Rate-limit buckets bounded without a prune                                                                                                                                    | `packages/server/test/RateLimiter.test.ts`                                                |
| The hide list, labels, an hour's cache on events; the relayer health read                                                                                                     | `packages/server/test/Moderation.api.test.ts`, `Events.api.test.ts`, `Api.test.ts`        |
