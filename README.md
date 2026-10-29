# Sidequest v2

Sidequest v2 is the clean technical foundation for the next Sidequest protocol iteration. It inherits the Styld v2 Effect, Foldkit, Alchemy and Cloudflare stack, but contains no Sidequest v1 business logic yet.

The existing Sidequest v1 repository and live protocol remain separate. Feature ports will arrive only after this foundation passes its local, native runtime and preview gates.

## Stack

Bun, Effect, Foldkit, Zyzz, Alchemy, Cloudflare Workers, D1/Drizzle, Durable Objects, R2, x18n, tsrs, Oxlint, Oxfmt and native Workerd/Chromium acceptance.

## Commands

```sh
bun install --frozen-lockfile
bun run check
bun run --cwd apps/web dev
bun run dev:preview
```

The foundation is intentionally small: the browser shell, typed runtime boundaries, health endpoint, persistence seam, observability seam, agent skills and quality gates come first.
