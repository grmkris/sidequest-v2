# Reality check

Local source, native Workerd tests, deployed preview checks and production behavior are separate evidence levels. No production release, mainnet transaction or live user migration belongs to the foundation bootstrap.

The preview stage is now deployed and health/document probes are verified. GitHub Actions has a preview deploy workflow, but its Cloudflare API token secret is not configured yet; direct deployment from the authorized build box is the current live evidence.

## Known foundation gaps (verified 2026-10-30)

The gates pass, but they prove less than the foundation docs implied. Close these before the first feature slice (see [FEATURE-PORT-PLAN.md](FEATURE-PORT-PLAN.md)):

- **No native runtime acceptance.** `packages/server/src/test/Runtime.native.test.ts` only checks that two source files contain certain strings. Nothing runs the stack in Workerd or drives Chromium, although CI installs Playwright. Styld v2's `packages/server/test/Runtime.native.test.ts` is the model.
- **The typed API is not served.** `packages/protocol` declares `GET /api/status`, but the Worker serves only a hand-built `/api/health`, and the server does not depend on `@sidequest/protocol`. On the preview, `/api/status` returns 404.
- **The page shows the wrong release.** `apps/web/src/entry.server.ts` renders `release: 'local-build'`, and nothing reads the `VITE_SIDEQUEST_RELEASE` or `VITE_SIDEQUEST_ENV` values `alchemy.run.ts` sets. Both Workers also receive `SIDEQUEST_ENV: 'preview'` on every stage.
- **CI deploys would lose state.** The stack uses `Alchemy.localState()`, so a GitHub runner starts with no record of the preview resources this box deployed. Configuring the token alone is not enough; CI needs shared state, or deploys stay on the box.
- **`packages/auth` is unwired.** Nothing imports it, and `packages/db/migrations` is empty, so the preview D1 database has no tables.
- **`wallet_links.chain_id` is an integer.** Integers cannot hold Stellar or other CAIP-2 network references; replace it before wallet linking lands.
