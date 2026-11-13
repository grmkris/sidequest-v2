# Sidequest v2

This repository is a clean foundation for Sidequest's next protocol iteration. Do not port v1 business logic, contracts, wallet flows or production data outside the accepted phases of `docs/ROADMAP.md`.

The wallet will be Nod, ported from `~/code/hack-meridian-2026` (a Stellar wallet inside AI chats: passkeys and a spending-limit allowance; live at trynod.si), in place of v1's Privy/Monad wallet flows. The same rule applies: port it only in an accepted roadmap phase. trynod.si stays live until the port is done.

## Stack

Use the pinned Styld v2 conventions: Bun, Effect, Foldkit, Zyzz, Alchemy, Cloudflare Workers, D1, Durable Objects, R2, x18n, tsrs, Oxlint, Oxfmt, Vitest and native Workerd/Chromium tests. Read `FOLDKIT.md` before UI work and the vendored Foldkit source for API truth.

## Workflow

Work on `main`. Preserve concurrent edits. Stage explicit paths and commit coherent green changes. Never commit secrets, generated deployment state, private data or live wallet material. Do not deploy production or send mainnet transactions.

## Boundaries

`apps/web` is Foldkit-only. `packages/protocol` owns shared schemas. `packages/domain` will own future durable aggregates. `packages/server` owns the Worker and transport boundaries. Future chain adapters must remain outside the browser graph. Nod will live here as its own app and packages; Nod packages never import Sidequest packages, and Sidequest's settlement code reaches Nod only through the payment adapter interface. Scope decisions are in `docs/adr/` and sequencing in `docs/ROADMAP.md`; `docs/STATUS.md` records what is true today.

Phase 2 makes Sidequest Nostr-native (`docs/adr/0003-nostr-native.md`): signed Nostr events carry coordination, only wallet signatures bind, the server is an index, and there is no server-side chat. `packages/nostr` owns events, signatures and the Sidequest event kinds; it is browser-safe and never imports a Nostr library.
