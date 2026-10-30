# Status

## Foundation bootstrap

- Source: Styld v2 commit `d0663c3`.
- Sidequest v1 logic: intentionally not ported.
- Browser: minimal Foldkit SSR/hydration shell.
- Server: Alchemy/Cloudflare Worker and health boundary.
- Persistence: identity/OAuth schema seam only.
- Protocol, domain, settlement and MCP behavior: deferred.
- Validation evidence (2026-10-30, local checkout): `bun run check` passed. This includes formatting, repo-agent configuration, vendored-source provenance, localization, dependency graph, suppression census, checker canaries, Effect/typecheck, strict Oxlint, Knip (development and production), duplication, 28 unit tests, the native boundary test and bundle budgets. The browser/SSR build completed inside `test:native`.
- Preview evidence (2026-10-30): Alchemy stage `preview` deployed commit `41e37f1` at `https://sidequestv2-sidequestedge-preview-xfwdaimchbooajzk.kristjan-grm11775.workers.dev`. `GET /api/health` returned HTTP 200 with release `41e37f1`; `GET /` returned HTTP 200 with the Foldkit document and edge security headers. This is preview evidence only; no production deploy, wallet transaction or user migration was performed.
- Foundation commit: `8dc92ad` (`foundation: bootstrap Sidequest v2 from Styld stack`).
- Delivery commits: `a4dfef6` (preview CI/CD and stack review), `906588e` (deployable empty D1 migration seam), `41e37f1` (preview evidence documentation).
- Known gaps (2026-10-30): the native test is a source-text check, `/api/status` is not served, the page shows `release local-build`, CI deploys lack shared Alchemy state, `packages/auth` is unwired and D1 has no migrations. Details in [REALITY-CHECK.md](REALITY-CHECK.md).

## V2 scope

- Decided 2026-10-30 in [ADR-0001](adr/0001-v2-scope.md):
  - the V1 suite ported to fresh Monad and Base deployments, with SIDE bridged for Base bonds;
  - direct and escrow payment rails behind one adapter;
  - Nod as the embedded wallet in this monorepo;
  - the x402 seller route;
  - Sidequest-hosted Nostr-shaped rooms.
- Sequenced in [FEATURE-PORT-PLAN.md](FEATURE-PORT-PLAN.md) (proposed; not yet accepted, so no V1 or Nod code has been ported).
