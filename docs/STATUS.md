# Status

- **Phase:** 1, slices 1–8 of 9 are built ([roadmap](ROADMAP.md), [phase 1 spec](PHASE-1.md)). Slice 9, the live Arc testnet journey and the technical gate, has not started.
- **Source:** bootstrapped from Styld v2 commit `d0663c3` on 2026-10-29. No Sidequest V1 or Nod code has been ported.
- **Preview (2026-11-12):** Alchemy stage `preview`, deployed from the build box at release `b5d711e`, at `https://sidequestv2-sidequestedge-preview-xfwdaimchbooajzk.kristjan-grm11775.workers.dev`. Checked live: `GET /api/status` returned release `b5d711e` and protocol `0.2-phase1`; the home page rendered; `GET /api/listings` and `GET /api/jobs` returned 200; a sign-in challenge was issued; `POST /mcp` without a token returned 401. Preview evidence says nothing about production.
- **Acceptance:** `bun run check` runs the built stack in workerd and drives headless Chromium, including a wallet-backed sign-in and posting a request.
- **Contracts:** `SidequestOperator` has unit, fuzz, invariant and Arc testnet fork tests. It is not deployed anywhere.

## What is proven, and at which level

| Part                                                                              | Level                               |
| :-------------------------------------------------------------------------------- | :---------------------------------- |
| Domain rules, HTTP API, MCP tools, website flows                                  | local tests                         |
| Sign-in, the off-chain hire through the edge, Durable Objects with D1 projections | workerd (local)                     |
| A full hire with funding, delivery, approval, ruling and silent settlement        | local Anvil with the real contracts |
| `SidequestOperator` against the deployed escrow                                   | Arc testnet fork                    |
| Anything on a live chain, a real wallet, a third-party MCP client                 | not proven                          |

## Known gaps

- Settlement is not configured on the preview (no operator address, relayer key or arbitrator key), so its endpoints answer 503.
- The MCP endpoint speaks only revision 2026-07-28; clients on older revisions are refused. There is no OAuth flow: agents use a token their person issues.
- Pages render their shell on the server and read data after hydration; the website Worker has no binding to the API.
- Missing reads: a bidder's view of the request and stage, a newest-first inbox, my listings, account names.
- The Anvil journeys do not run in CI, which has no Foundry in the checks job.
- The relayer does not repair a nonce gap left by a permanently refused transaction.
- Deploy state is local to the build box, so only the build box can deploy.
- Disputes are settled by an arbitrator key Sidequest holds; they are not trustless until staked arbitrators exist.
- The Slovenian copy has not been reviewed by a native speaker.
