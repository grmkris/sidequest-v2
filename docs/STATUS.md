# Status

- **Phase:** 2 has started; the product still runs on phase 1. Phase 1's nine slices are built and its technical gate has passed on Arc testnet for three of its four cases; the fourth (buyer reclaim after expiry) has passed only on a local chain. The market gate (an outside agent completes a hire) is open ([roadmap](ROADMAP.md), [phase 1 spec](PHASE-1.md)).
- **Source:** bootstrapped from Styld v2 commit `d0663c3` on 2026-10-29. No Sidequest V1 or Nod code has been ported.
- **Contract:** `SidequestOperator` is deployed on Arc testnet (chain 5042002) at `0x979Ef80b97702ebCFCf6b0D9f9fc015C50C15a99`, with a 500 bps fee to a throwaway test treasury. It is unaudited and exists on no other chain.
- **Preview:** Alchemy stage `preview`, deployed from the build box, at `https://sidequestv2-sidequestedge-preview-xfwdaimchbooajzk.kristjan-grm11775.workers.dev`. Settlement is not enabled on it. Preview evidence says nothing about production.

## Phase 2 so far (2026-11-13)

Built beside phase 1 and not yet used by the website, MCP or settlement, which still run on accounts, sessions and server-held jobs and rooms. Nothing below is deployed to the preview.

| Piece                                                                                                            | State                                                                                   |
| :--------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------- |
| `packages/nostr`: events, signatures, NIP-19/44/59/98, Sidequest's kinds (8410–8420), wallet-link typed data     | built, unit-tested against the NIPs' vectors                                            |
| The index: stored events, profiles, relay lists, wallet links, agent grants; `POST /api/events` and public reads | built; tested on SQLite and in workerd; the same events in any order give the same rows |
| Outbox and relay poller                                                                                          | built; tested against an in-process relay only; no relay is configured on any stage     |
| The relay pipe: `GET /relay?url=` on the edge, a same-origin WebSocket to a public relay                         | built (server half); tested in workerd against an in-process relay; no page uses it yet |
| `packages/fold`: a job's state from signed events and chain facts                                                | built and tested; nothing calls it yet                                                  |
| Rooms                                                                                                            | decided: NIP-17 ([ADR-0004](adr/0004-rooms-on-nip-17.md)); not built                    |

Not proven for these: a connection from a deployed Worker to a public relay (the index's or the pipe's), the pipe's per-address bounds on Cloudflare, where each isolate counts alone, the scheduled runs firing on Cloudflare, the index's queries on a deployed D1, and whether public relays keep Sidequest's kinds. A contract wallet's link is stored as unverified: checking it needs a chain call the index does not make.

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

- A real wallet (MetaMask, Rabby) in a browser, and the money steps on the deployed preview.
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
