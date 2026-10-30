# Stack review

Reviewed 2026-10-30 against Styld v2 commit `d0663c3`, the pinned Effect 4 guidance, the vendored FoldKit release and the installed Alchemy Cloudflare provider.

## Results

- **FoldKit:** `apps/web` imports the published `foldkit` package and `@foldkit/ui`; the vendored `repos/foldkit` subtree is read-only reference material pinned to `foldkit@0.169.0`. SSR and hydration stay in separate entries, and the application follows the Elm-shaped Model, Message, init, update and view boundary.
- **Effect:** runtime wiring is expressed with `Effect.gen`, `Layer.mergeAll`, typed schemas and the Cloudflare binding layers. The server has no native HTTP or database calls outside the Effect boundary.
- **Alchemy:** one Stack owns the website, edge Worker, API Worker, D1 database and R2 bucket. The preview stage uses Alchemy local state, matching Styld v2 and keeping resource ownership explicit.
- **Cloudflare:** the public edge Worker routes API namespaces to the API service binding and all other requests to the FoldKit website. Security headers are applied at the edge. The API health response now reports the deployed `SIDEQUEST_RELEASE` value.
- **Boundaries:** the browser graph has no server, database or chain imports. The protocol, domain, server and database packages remain separate, and no Sidequest v1 behavior is present.
- **Quality:** the full repository gate remains the source of truth for formatting, agent configuration, provenance, localization, graph boundaries, Effect diagnostics, lint, unused code, duplication, unit tests, native runtime and bundle budgets.

## Delivery lane

`.github/workflows/check.yml` runs the complete gate on pushes and pull requests. `.github/workflows/deploy-preview.yml` deploys the exact successful `main` commit to Alchemy stage `preview`; it never targets `prod`. The workflow requires the repository variable `CLOUDFLARE_ACCOUNT_ID` and the repository secret `CLOUDFLARE_API_TOKEN`.

A deployed preview is evidence for the preview stage only. It does not prove production behavior, authenticated flows, protocol behavior, chain settlement or user migration.

## Reference sources

- Styld v2: `/home/kristjan/code/styldappv2` at `d0663c3`.
- FoldKit: `repos/foldkit`, `foldkit/foldkit@0.169.0`, verified by `repos/sources.json`.
- Alchemy Domain guidance: `.agents/skills/alchemy-domain` and its pinned provenance entry for `alchemy-run/alchemy`.
