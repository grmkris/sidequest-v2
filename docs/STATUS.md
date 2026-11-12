# Status

- **Phase:** 0, foundation ([roadmap](ROADMAP.md)).
- **Source:** bootstrapped from Styld v2 commit `d0663c3` on 2026-10-29. No Sidequest V1 or Nod code has been ported.
- **Preview:** Alchemy stage `preview`, deployed from the build box, at `https://sidequestv2-sidequestedge-preview-xfwdaimchbooajzk.kristjan-grm11775.workers.dev`. Last recorded release: `41e37f1` (2026-10-30). Preview evidence says nothing about production.

## Known gaps

- The native test only checks source text; nothing runs the stack in Workerd or drives a browser.
- `packages/protocol` declares `GET /api/status`, but the Worker serves a hand-built `/api/health`.
- The page renders `release local-build`, and both Workers receive `SIDEQUEST_ENV: 'preview'` on every stage.
- Deploy state is local to the build box, so the GitHub deploy workflow cannot work.
