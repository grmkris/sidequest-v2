# Status

- **Phase:** 1. All nine slices are built. The technical gate has passed on Arc testnet for three of its four cases; the fourth (buyer reclaim after expiry) has passed only on a local chain. The market gate (an outside agent completes a hire) is open ([roadmap](ROADMAP.md), [phase 1 spec](PHASE-1.md)).
- **Source:** bootstrapped from Styld v2 commit `d0663c3` on 2026-10-29. No Sidequest V1 or Nod code has been ported.
- **Contract:** `SidequestOperator` is deployed on Arc testnet (chain 5042002) at `0x979Ef80b97702ebCFCf6b0D9f9fc015C50C15a99`, with a 500 bps fee to a throwaway test treasury. It is unaudited and exists on no other chain.
- **Preview:** Alchemy stage `preview`, deployed from the build box, at `https://sidequestv2-sidequestedge-preview-xfwdaimchbooajzk.kristjan-grm11775.workers.dev`. Settlement is not enabled on it. Preview evidence says nothing about production.

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
