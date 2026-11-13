# Sidequest v2

This repository is a clean foundation for Sidequest's next protocol iteration. Do not port v1 business logic, contracts, wallet flows or production data outside the accepted phases of `docs/ROADMAP.md`.

The wallet will be Nod, ported from `~/code/hack-meridian-2026` (a Stellar wallet inside AI chats: passkeys and a spending-limit allowance; live at trynod.si), in place of v1's Privy/Monad wallet flows. The same rule applies: port it only in an accepted roadmap phase. trynod.si stays live until the port is done.

## Stack

Use the pinned Styld v2 conventions: Bun, Effect, Foldkit, Zyzz, Alchemy, Cloudflare Workers, D1, Durable Objects, R2, x18n, tsrs, Oxlint, Oxfmt, Vitest and native Workerd/Chromium tests. Read `FOLDKIT.md` before UI work and the vendored Foldkit source for API truth.

## Workflow

Work on `main`. Preserve concurrent edits. Stage explicit paths and commit coherent green changes. Never commit secrets, generated deployment state, private data or live wallet material. Do not deploy production or send mainnet transactions.

## Boundaries

Sidequest is Nostr-native (`docs/adr/0003-nostr-native.md`, `docs/PHASE-2.md`): signed Nostr events carry coordination, only wallet signatures bind, the server is an index, and there is no server-side chat, no account, no session and no cookie. Phase 1's server-authoritative code is deleted; do not bring back sign-in, sessions or a server-side model.

`apps/web` is Foldkit-only. `packages/protocol` owns shared schemas and the HTTP API and depends on nothing of ours. `packages/nostr` owns events, signatures, encryption, rooms and the Sidequest event kinds; it is browser-safe and never imports a Nostr library. `packages/fold` owns a job's state as a pure fold over events and chain facts, run by the index and the website alike. `packages/settlement` owns the chain adapters (payments, the relayer, the chain's logs) and stays outside the browser graph. `packages/serving` holds what the core and the gateway share. `packages/server` owns the core's Workers: the edge, the index, the escrow and the relay pipe. `apps/gateway` holds agents' keys and serves MCP and OAuth; it reaches the core only through its public API, and nothing imports it. Nod will live here as its own app and packages; Nod packages never import Sidequest packages, and Sidequest's settlement code reaches Nod only through the payment adapter interface. Scope decisions are in `docs/adr/` and sequencing in `docs/ROADMAP.md`; `docs/STATUS.md` records what is true today.
