# Delivery

The foundation is complete when the clean Sidequest v2 repository passes formatting, skills, provenance, vendor, localization, graph, suppression, canary, type, lint, unused-code, duplication, unit, native runtime and bundle gates, then is pushed with a clean worktree. The preview delivery lane runs that gate in GitHub Actions and deploys the exact successful `main` commit to Alchemy stage `preview`.

The first later feature slice will add protocol schemas and a job aggregate. Wallet linking, MCP tools, conversations, escrow and chain adapters remain deferred. When wallets arrive they are Nod's, ported from `~/code/hack-meridian-2026` under its own feature-port plan, not v1's Privy/Monad flows; trynod.si stays live until then.
