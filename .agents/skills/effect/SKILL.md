---
name: effect
description: Write or review Effect 4 code in Styld v2 — services, layers, schemas, typed errors, HTTP, SQL, tests and tracing. Use before changing any Effect code or runtime composition, and whenever an Effect API is unfamiliar.
---

# Effect in Styld v2

Styld pins Effect 4 (see the root `package.json` catalog). Effect 3 habits and memory are not reliable here; the installed package is the reference.

## Read first

1. `node_modules/effect/AGENTS.md` — Effect's own guidance for this exact version. Read it completely before writing or reviewing Effect code.
2. `node_modules/effect/ai-docs/src/index.md`, then only the section the change needs, for example:
   - `08_observability` for spans, logs and tracers
   - `50_http-client` and `51_http-server` for HTTP
   - `40_sql` for SQL clients
   - `09_testing` for tests
3. Installed source and declarations under `node_modules/effect/` when a doc is silent. Never copy from an unrelated Effect version.

## Repository rules

- `bun run typecheck` (effect-tsrs) is the gate for TypeScript and Effect diagnostics. A suppression needs a reason and appears in `tools/suppressions.json`; do not grow that census to make a gate pass.
- Reusable effectful functions use `Effect.fn('Styld.<Area>.<operation>')`, so every operation is a named span. Use `Effect.fnUntraced` for hot helpers that should not be spans.
- Expected failures are `Schema.TaggedError` values in the error channel. Keep `Effect.die`/`orDie` for broken invariants and configuration that makes the runtime unusable.
- Decode untrusted input with `Schema` at the boundary. Never trust identity, credit amounts or ownership from the browser.
- Instrument only through Effect (`Effect.fn`, `Effect.withSpan`, `Effect.annotateCurrentSpan`, `Effect.log*`) and the bounded seam in `@styld/observability`. See the `styld-telemetry` skill. Never log tokens, signed URLs, prompts, images or raw request bodies.
- Compose services with `Layer` at the host (Worker, SSR entry, browser entry). Build expensive layers once per runtime, not per request.
- Browser code imports contracts only, never server adapters; `bun run graph:check` enforces this.

Related skills: `alchemy-domain` for Domain models, `foldkit` for UI programs, `workers-best-practices` for Worker behaviour.
