# Status

- **Phase:** 2 ([roadmap](ROADMAP.md), [phase 2 spec](PHASE-2.md)). Sidequest is one system on signed Nostr events: the index, the fold, the escrow and its settler, the agent gateway and encrypted rooms. Phase 1's server-authoritative code (accounts, wallet sign-in, sessions, the model on Durable Objects, the core's MCP and OAuth) is deleted. The phase 2 technical gate has passed on Arc testnet for four of its five cases; the fifth (buyer reclaim after expiry) has passed only on a local chain. The market gate (an outside agent completes a hire) is open.
- **Source:** bootstrapped from Styld v2 commit `d0663c3` on 2026-10-29. No Sidequest V1 or Nod code has been ported.
- **Contract:** `SidequestOperator` v2 (delivery delegation) is deployed on Arc testnet (chain 5042002) at `0xA515f69EcAE571B1c7BC0911b3D1550f9eDb974b`, in block 72190184 (`0x44d88e8`), with a 500 bps fee to a throwaway test treasury. It is unaudited and exists on no other chain. It supersedes v1 at `0x979Ef80b97702ebCFCf6b0D9f9fc015C50C15a99`, which stays on chain unused.
- **Preview:** Alchemy stage `preview`, deployed from the build box, at `https://sidequestv2-sidequestedge-preview-xfwdaimchbooajzk.kristjan-grm11775.workers.dev`, last at release `3a268ff`, before phase 1 was deleted. Its next deploy deletes phase 1's Durable Object classes and tables ([PHASE-2.md](PHASE-2.md), "Deploying over phase 1"). Settlement is not enabled on it. Preview evidence says nothing about production.

## What is built (2026-11-13)

People are Nostr keys with a linked wallet; there is no account, session or cookie anywhere. The website's identity page links a key and a wallet; its home page, listings, requests and job pages run on signed events and the index; the job page carries the money steps (fund, deliver, approve, reject, review), each a wallet signature the API relays; the agents page runs on the agent gateway through the edge's `/gateway` proxy; the inbox is worked out in the browser. The server renders nothing personal.

| Piece                                                                                                                | State                                                                                                            |
| :------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------- |
| `packages/nostr`: events, signatures, NIP-19/44/59/98, Sidequest's kinds (8410–8420), wallet-link typed data         | built, unit-tested against the NIPs' vectors                                                                     |
| The index: stored events, profiles, relay lists, wallet links, agent grants; `POST /api/events` and public reads     | built; tested on SQLite and in workerd; the same events in any order give the same rows                          |
| Outbox and relay poller                                                                                              | built; tested against an in-process relay only; no relay is configured on any stage                              |
| The relay pipe: `GET /relay?url=` on the edge, a same-origin WebSocket to a public relay                             | built; tested in workerd against an in-process relay; the job page's rooms use it                                |
| `packages/fold`: a job's state from signed events and chain facts                                                    | built and tested; the index's job read calls it                                                                  |
| The index's listings (NIP-99) and jobs: `GET /api/index/listings`, `/api/index/jobs`, `/api/index/jobs/:id`          | built; tested on SQLite and (one job read) in workerd; the website reads them, in Chromium in workerd            |
| Chain facts: a poller of the operator's and the escrow's logs into `chain_facts`, every minute where settled         | built; tested against Anvil; rehearsed against Arc testnet in local workerd; not run on Cloudflare               |
| The escrow: quote, fund, deliver, approve, reject, NIP-98 ruling, payment, terms                                     | built; fund's rules story-tested on SQLite; rehearsed on Anvil and Arc testnet (`gate:rehearse`)                 |
| The job page's money steps: fund, deliver, approve, reject, review; read-only escrow state, deadlines and endings    | built; story- and scene-tested; rehearsed in Chromium on Anvil (`gate:rehearse:browser`)                         |
| The settler: deadline calls from chain facts and the chain's time, on the minute Cron Trigger; funded terms kept     | built; story-tested on SQLite; rehearsed on Anvil and Arc testnet in local workerd; not run on Cloudflare        |
| Delivery delegation: `SidequestOperator` v2 `deliverDelegated`, the two escrow endpoints, the gateway's `deliver`    | built; Foundry unit, fuzz, invariant and fork tests; rehearsed on Anvil (`gate:rehearse` (e))                    |
| Rooms (`@sidequest/nostr/rooms`): `RoomTransport` over NIP-17, Lamport-ordered, founder-run membership, disclosures  | built; story-tested over memory relays (48 h catch-up, 100-event pages, same-second order, removal, tampering)   |
| Rooms on the job page: the relay pipe, IndexedDB, private proposals, inbox relays (10050), `/evidence`               | built; story-tested; in Chromium in workerd against a local inbox relay with NIP-42 and fake NIP-07 `nip44`      |
| Rooms for gateway agents: `list_rooms`, `read_room_messages`, `send_room_message`, turn limit, pause                 | built; tested with the core in workerd against a local inbox relay; not deployed                                 |
| The agent gateway (`apps/gateway`): its own Worker and D1, sealed per-agent keys, grant gate, OAuth, MCP tools       | built; tested against a core double and, with the core, in workerd; not deployed                                 |
| The agents page: create, grant, revoke, pause, delete, the MCP URL, delivery delegation; the edge's `/gateway` proxy | built; story-tested; in Chromium in workerd with the gateway (not the delegation); no stage sets the gateway URL |
| The inbox in the browser: a key's jobs (`GET /api/people/:pubkey/jobs`, at most 25), the fold, the room store        | built; story-tested; a proposal shown in Chromium in workerd; money items proven only in story tests             |

Checked on the preview (2026-11-13, release `3a268ff`, from a script, not a browser): a signed profile, request and proposal published through `POST /api/events` and read back as a person and a job in stage `proposed` from the deployed D1; the relay pipe carrying a subscription to two public relays (nos.lol, relay.primal.net); a pipe from another origin refused.

The agent gateway (roadmap slice 8, [README](../apps/gateway/README.md)) reaches the core only through its public API. An operator's key makes an agent there (NIP-98), grants it with a signed event published through the core, and consents to an MCP client on the gateway's own page; the agent then signs as its own key under that grant, which the gateway re-reads from the index at most every 30 seconds. Its tools: whoami, search_listings, list_open_requests, get_job, get_person, payment_status, propose, withdraw_proposal, accept, deliver, delivery_delegation and the room tools. The fold counts an agent's proposal, accept, statement and delivery note as its operator's when the grant it names is that operator's, for that key, has the action's scope, holds the event's `created_at` in its window and is not revoked (a revoked grant authorises nothing, whenever the revocation arrived; only the funded proposal keeps its operator as the worker, because the chain's money is never undone). The job page shows an accept by the buyer's agent as such, and an accept by a key the buyer granted that does not count as that agent's suggestion, which the buyer accepts in one click. Unless the operator's wallet delegated the job's delivery to the agent's key, the agent's delivery note comes with the typed data the operator's wallet must sign.

Not proven: a deployed gateway; a real MCP client (claude.ai, ChatGPT, Cursor) or NIP-07 extension on its consent page; a real public inbox relay (with or without NIP-42), a real NIP-07 extension's `nip44`, Firefox and WebKit, and an outside NIP-17 client reading a room's text; the index's own connections to relays from a deployed Worker (no relay is configured); the scheduled runs doing work on Cloudflare; the pipe's per-address bounds on Cloudflare, where each isolate counts alone; a real Nostr extension or wallet on the identity page; whether public relays keep Sidequest's kinds. A contract wallet's link is stored as unverified: checking it needs a chain call the index does not make.

## Gate evidence

### Phase 2 (2026-11-13)

`bun run gate:rehearse` (`tools/rehearsal/GateRehearsal.native.test.ts`) deploys the core and the agent gateway together in local workerd, each its own Worker and D1, the gateway knowing only the core's URL. The buyer is a fresh Nostr key with a linked wallet, acting over HTTP (`POST /api/events` and the escrow endpoints). The worker is a fresh Nostr key that makes an agent at the gateway (NIP-98), grants it `propose` and `deliver` with a signed grant published through the core, and consents to an MCP client over OAuth; the agent finds the request (`list_open_requests`), proposes (`propose`, paying the worker's linked wallet) and delivers (`deliver`), and the fold counts its events as the worker's. Wallets sign only money; the relayer pays all gas. Money's stage is read from the index's fold, fed by the chain log poller and the settler on the API Worker's minute Cron Trigger, which fires in the local runtime; nothing triggers them by hand. Until phase 1 was deleted this rehearsal was `gate:rehearse:events`; its evidence files still name it `phase-2-events-gate`.

| Case                                                                                                     | Local chain (Anvil) | Arc testnet, operator v2                                    |
| :------------------------------------------------------------------------------------------------------- | :------------------ | :---------------------------------------------------------- |
| a) The worker's agent proposes over MCP; the buyer accepts and funds; the worker's wallet delivers; paid | passed              | passed (158 s)                                              |
| b) Rejected; a NIP-98 ruling by the arbitration key splits it 60/40                                      | passed              | passed (239 s)                                              |
| e) The worker's wallet delegates once; the agent delivers with no wallet signature; approved; paid       | passed              | passed (179 s)                                              |
| c) Funded, never delivered; the settler refunds after the deadline                                       | passed              | passed (300 s; refunded 115 s after the deadline passed)    |
| d) Settlement withheld until expiry; the buyer reclaims from the escrow                                  | passed              | not run: the escrow expires at least 38 hours after funding |

The Arc testnet run, before phase 1 was deleted, is [evidence/2026-11-13-arc-testnet-events-gate.json](evidence/2026-11-13-arc-testnet-events-gate.json): 12 relayed transactions, all mined; each confirmed three blocks deep in 4 to 19 s; the 214 requests through the proxy all answered. It records which key signed each event (the buyer's key, the worker's agent's key under its grant) and each gateway call. The run did not include a browser or the website (the buyer used a script, not the job page), a real MCP client (claude.ai, ChatGPT, Cursor), rooms, or deployed Workers: both Workers ran in local workerd, and their Cron Triggers fired there, not on Cloudflare. The wallets were test keys. The Anvil column has been rehearsed again since the deletion; Arc testnet has not.

`bun run gate:rehearse:browser` (`packages/server/rehearsal/BrowserRehearsal.native.test.ts`) runs a hire released and one rejected on the website, by two people in Chromium with a test NIP-07 extension and a test wallet each, on Anvil only.

On 2026-11-13 Arc testnet made blocks 3.9 s apart on average, and up to 30 s apart while two of its validators proposed, against 0.55 s on 2026-11-12; a relayed step then took 6 to 37 s to be included and confirmed three blocks deep. The rehearsal waits for that confirmation on chain, recording how long it took, before it gives the stack its time to show the step.

### Phase 1 (superseded)

Phase 1's gate drove hires over its HTTP and MCP surfaces, with accounts, wallet sign-in and the model on Durable Objects. That code is deleted and the rehearsal with it; these results are history.

| Case                                                                                         | Local chain (Anvil) | Arc testnet, operator v2                                    |
| :------------------------------------------------------------------------------------------- | :------------------ | :---------------------------------------------------------- |
| a) An agent proposes over MCP; the buyer funds; delivered; approved; paid with the exact fee | passed              | passed                                                      |
| b) Rejected, then split by an arbitrator's ruling                                            | passed              | passed                                                      |
| c) Funded, never delivered; the saga refunds after the deadline                              | passed              | passed                                                      |
| d) Settlement withheld until expiry; the buyer reclaims from the escrow                      | passed              | not run: the escrow expires at least 38 hours after funding |

Evidence: [evidence/2026-11-13-arc-testnet-gate-v2.json](evidence/2026-11-13-arc-testnet-gate-v2.json) (operator v2) and [evidence/2026-11-12-arc-testnet-gate.json](evidence/2026-11-12-arc-testnet-gate.json) (operator v1). In both runs the stack ran in local workerd, not on Cloudflare, and the wallets were test keys.

## Not proven

- A real wallet (MetaMask, Rabby) in a browser, and the money steps on the deployed preview. The website's money steps are proven only with a test wallet and a test NIP-07 extension in Chromium, against local workerd and Anvil.
- Reclaiming from the website: the job page tells a buyer whose authorization expired to call `reclaim` on the escrow it names, and builds no transaction.
- A third-party MCP client (claude.ai, ChatGPT, Cursor, Claude Code) connecting to the gateway over OAuth.
- The buyer's reclaim on a live chain.
- Deleting phase 1's Durable Object classes on a deployed stage: Alchemy's delete-class path is read from its source, not yet run against the preview.

## Known gaps

- Disputes are settled by an arbitrator key Sidequest holds; they are not trustless until staked arbitrators exist, and a ruling sees no disclosed evidence yet.
- The API sends no CORS headers: a third-party web client on another origin cannot call it from a browser.
- No rate limiting on the gateway's OAuth endpoints (its MCP tools are limited per agent).
- A job funded by the first live run (`0x1546…`, 0.1 test USDC, operator v1) stays in the escrow on Arc testnet until the test buyer reclaims it after expiry.
- Deploy state is local to the build box, so only the build box can deploy.
- The Slovenian copy has not been reviewed by a native speaker.
