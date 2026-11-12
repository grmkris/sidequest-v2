# Status

- **Phase:** 0 is complete; phase 1 is next ([roadmap](ROADMAP.md)).
- **Source:** bootstrapped from Styld v2 commit `d0663c3` on 2026-10-29. No Sidequest V1 or Nod code has been ported.
- **Preview (2026-11-12):** Alchemy stage `preview`, deployed from the build box at release `d4d3daa`, at `https://sidequestv2-sidequestedge-preview-xfwdaimchbooajzk.kristjan-grm11775.workers.dev`. `GET /api/status` returned the typed status with release `d4d3daa`, and the page rendered `Release d4d3daa`. Preview evidence says nothing about production.
- **Acceptance:** `bun run check` runs the built stack in workerd and loads the page in headless Chromium (`packages/server/src/test/Runtime.native.test.ts`).

## Known gaps

- Deploy state is local to the build box, so only the build box can deploy.
- Static files served straight from Worker assets, and their `_headers` rules, are not covered by the acceptance test.
- The website path of `alchemy dev` fails in alchemy 2.0.0-beta.84 (`register-dev-mode.js` is missing from the package); use `bun run --cwd apps/web dev` for the page.
