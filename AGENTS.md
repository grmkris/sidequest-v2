# Sidequest v2

This repository is a clean foundation for Sidequest's next protocol iteration. Do not port v1 business logic, contracts, wallet flows or production data until the foundation gates pass and a feature-port plan is accepted.

## Stack

Use the pinned Styld v2 conventions: Bun, Effect, Foldkit, Zyzz, Alchemy, Cloudflare Workers, D1/Drizzle, Durable Objects, R2, x18n, tsrs, Oxlint, Oxfmt, Vitest and native Workerd/Chromium tests. Read `FOLDKIT.md` before UI work and the vendored Foldkit source for API truth.

## Workflow

Work on `main`. Preserve concurrent edits. Stage explicit paths and commit coherent green changes. Never commit secrets, generated deployment state, private data or live wallet material. Do not deploy production or send mainnet transactions.

## Boundaries

`apps/web` is Foldkit-only. `packages/protocol` owns shared schemas. `packages/domain` will own future durable aggregates. `packages/server` owns the Worker and transport boundaries. `packages/db` owns relational persistence. Future chain adapters must remain outside the browser graph.

The current foundation has no job, conversation, escrow, settlement or agent business behavior.
