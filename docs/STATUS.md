# Status

- **Phase:** 2 has started; the product still runs on phase 1. Phase 1's nine slices are built and its technical gate has passed on Arc testnet for three of its four cases; the fourth (buyer reclaim after expiry) has passed only on a local chain. The market gate (an outside agent completes a hire) is open ([roadmap](ROADMAP.md), [phase 1 spec](PHASE-1.md)).
- **Source:** bootstrapped from Styld v2 commit `d0663c3` on 2026-10-29. No Sidequest V1 or Nod code has been ported.
- **Contract:** `SidequestOperator` is deployed on Arc testnet (chain 5042002) at `0x979Ef80b97702ebCFCf6b0D9f9fc015C50C15a99`, with a 500 bps fee to a throwaway test treasury. It is unaudited and exists on no other chain. That deployment is v1: the source is now v2 (slice 13, delivery delegation), which is built and tested on Anvil and an Arc testnet fork but not yet redeployed there.
- **Preview:** Alchemy stage `preview`, deployed from the build box, at `https://sidequestv2-sidequestedge-preview-xfwdaimchbooajzk.kristjan-grm11775.workers.dev`. Settlement is not enabled on it. Preview evidence says nothing about production.

## Phase 2 so far (2026-11-13)

Built beside phase 1. On the website, the identity page (a Nostr key and the wallet link) and the marketplace before funding run on signed events and the index: the home page's requests and listings, a listing and its new versions, a request and its job page, proposals, revisions, withdrawals, the buyer's accept and closing a request. The job page also carries the money steps on the sessionless escrow: the buyer funds from a slip, the worker delivers (a signed delivery note, then the wallet's signature of its hash), the buyer approves or rejects with a signed reason, and once settled each side may review the other; each step is a wallet signature the API relays, from the wallet linked to the acting key. Phase 1's job page is gone; agents, connections and the inbox still run on accounts and sessions, as do MCP and settlement. Deployed to the preview at release `3a268ff`, before the marketplace pages moved.

| Piece                                                                                                               | State                                                                                                 |
| :------------------------------------------------------------------------------------------------------------------ | :---------------------------------------------------------------------------------------------------- |
| `packages/nostr`: events, signatures, NIP-19/44/59/98, Sidequest's kinds (8410–8420), wallet-link typed data        | built, unit-tested against the NIPs' vectors                                                          |
| The index: stored events, profiles, relay lists, wallet links, agent grants; `POST /api/events` and public reads    | built; tested on SQLite and in workerd; the same events in any order give the same rows               |
| Outbox and relay poller                                                                                             | built; tested against an in-process relay only; no relay is configured on any stage                   |
| The relay pipe: `GET /relay?url=` on the edge, a same-origin WebSocket to a public relay                            | built (server half); tested in workerd against an in-process relay; no page uses it yet               |
| `packages/fold`: a job's state from signed events and chain facts                                                   | built and tested; the index's job read calls it                                                       |
| The index's listings (NIP-99) and jobs: `GET /api/index/listings`, `/api/index/jobs`, `/api/index/jobs/:id`         | built; tested on SQLite and (one job read) in workerd; the website reads them, in Chromium in workerd |
| Chain facts: a poller of the operator's and the escrow's logs into `chain_facts`, every minute where settled        | built; tested against Anvil; not run against Arc testnet or on Cloudflare                             |
| Escrow without sessions for Nostr-native jobs: quote, fund, deliver, approve, reject, NIP-98 ruling, payment, terms | built; fund's rules story-tested on SQLite; rehearsed on Anvil (`gate:rehearse:events`)               |
| The job page's money steps: fund, deliver, approve, reject, review; read-only escrow state, deadlines and endings   | built; story- and scene-tested; rehearsed in Chromium on Anvil (`gate:rehearse:browser`)              |
| The settler: deadline calls from chain facts and the chain's time, on the minute Cron Trigger; funded terms kept    | built; story-tested on SQLite; rehearsed on Anvil; not run on Cloudflare or Arc testnet               |
| Delivery delegation: `SidequestOperator` v2 `deliverDelegated`, the two escrow endpoints, the gateway's `deliver`   | built; Foundry unit, fuzz, invariant and fork tests; rehearsed on Anvil (`gate:rehearse:events` (e))  |
| Rooms                                                                                                               | decided: NIP-17 ([ADR-0004](adr/0004-rooms-on-nip-17.md)); not built                                  |
| The agent gateway (`apps/gateway`): its own Worker and D1, sealed per-agent keys, grant gate, OAuth, MCP tools      | built; tested against a core double and, with the core, in workerd; not deployed; no website page yet |

Checked on the preview (2026-11-13, release `3a268ff`, from a script, not a browser): a signed profile, request and proposal published through `POST /api/events` and read back as a person and a job in stage `proposed` from the deployed D1; the relay pipe carrying a subscription to two public relays (nos.lol, relay.primal.net); a pipe from another origin refused.

The agent gateway (roadmap slice 8, [README](../apps/gateway/README.md)) runs beside the core and reaches it only through its public API. An operator's key makes an agent there (NIP-98), grants it with a signed event published through the core, and consents to an MCP client on the gateway's own page; the agent then signs as its own key under that grant, which the gateway re-reads from the index at most every 30 seconds. Its tools: whoami, search_listings, list_open_requests, get_job, get_person, payment_status, propose, withdraw_proposal, accept, deliver and delivery_delegation. An agent's accept is a signal the fold does not count as the buyer's. Its delivery note comes with the typed data the operator's wallet must sign, unless the operator's wallet delegated that job's delivery to the agent's key (slice 13: one `DeliveryDelegate` signature, stored at the gateway with NIP-98); then the agent's key records the delivery on chain itself, through the core's relay. No website page asks a wallet for a delegation yet. Phase 1's agents, tokens, MCP and OAuth stay in the core until the gateway is proven on a stage. Not proven: a deployed gateway, a real MCP client (claude.ai, ChatGPT, Cursor) or NIP-07 extension on its consent page.

Not proven for these: the index's own connections to relays from a deployed Worker (no relay is configured), the scheduled runs doing work on Cloudflare, the pipe's per-address bounds on Cloudflare, where each isolate counts alone, the chain-fact poller against Arc testnet, a real Nostr extension or wallet on the identity page, and whether public relays keep Sidequest's kinds. A contract wallet's link is stored as unverified: checking it needs a chain call the index does not make.

The roadmap's order has changed in one way: the pieces that add are built first, and wallet sign-in, sessions and the phase 1 aggregates are deleted together at the settlement cut-over, so every commit keeps a working hire. Ids are not renamed on aggregates about to be deleted.

## Gate evidence (2026-11-12)

`bun run gate:rehearse` drives hires over the public HTTP and MCP surfaces of the built stack in workerd, against real contracts.

| Case                                                                                         | Local chain (Anvil) | Arc testnet                                                 |
| :------------------------------------------------------------------------------------------- | :------------------ | :---------------------------------------------------------- |
| a) An agent proposes over MCP; the buyer funds; delivered; approved; paid with the exact fee | passed              | passed                                                      |
| b) Rejected, then split by an arbitrator's ruling                                            | passed              | passed                                                      |
| c) Funded, never delivered; the saga refunds after the deadline                              | passed              | passed                                                      |
| d) Settlement withheld until expiry; the buyer reclaims from the escrow                      | passed              | not run: the escrow expires at least 38 hours after funding |

The Arc testnet run's transactions are in [evidence/2026-11-12-arc-testnet-gate.json](evidence/2026-11-12-arc-testnet-gate.json). In that run the stack ran in local workerd, not on Cloudflare, and the wallets were test keys, not a browser wallet.

## Not proven

- A real wallet (MetaMask, Rabby) in a browser, and the money steps on the deployed preview. The website's money steps are proven only with a test wallet and a test NIP-07 extension in Chromium, against local workerd and Anvil.
- Reclaiming from the website: the job page tells a buyer whose authorization expired to call `reclaim` on the escrow it names, and builds no transaction.
- A third-party MCP client (claude.ai, ChatGPT, Cursor, Claude Code) connecting over OAuth.
- The saga wake-up fix running on Cloudflare itself (it is proven in local workerd).
- The buyer's reclaim on a live chain.

## Known gaps

- The workflow-engine fix is a local patch to `@alchemy.run/cloudflare` 2.0.0-beta.84 and has not been reported upstream.
- Disputes are settled by an arbitrator key Sidequest holds; they are not trustless until staked arbitrators exist.
- No rate limiting on the OAuth, registration or sign-in endpoints.
- The website has no pages for renaming an account, my listings or my jobs (the API has them).
- A job funded by the first live run (`0x1546…`, 0.1 test USDC) stays in the escrow on Arc testnet until the test buyer reclaims it after expiry.
- Deploy state is local to the build box, so only the build box can deploy.
- The Slovenian copy has not been reviewed by a native speaker.
