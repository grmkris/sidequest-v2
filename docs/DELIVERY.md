# Delivery

The foundation is complete when the clean Sidequest v2 repository passes formatting, skills, provenance, vendor, localization, graph, suppression, canary, type, lint, unused-code, duplication, unit, native runtime and bundle gates, then is pushed with a clean worktree. The preview delivery lane runs that gate in GitHub Actions and deploys the exact successful `main` commit to Alchemy stage `preview`.

Feature work follows the [feature-port plan](FEATURE-PORT-PLAN.md) (proposed) and [ADR-0001](adr/0001-v2-scope.md). The first slices run in parallel:

- **Track A:** protocol schemas, a job aggregate and direct USDC payment on Base testnet.
- **Track B:** the V1 contract port, rehearsed on Monad and Base forks.

When wallets arrive they are Nod's, ported from `~/code/hack-meridian-2026` under the plan's track D, not v1's Privy/Monad flows; trynod.si stays live until then. Escrow for users, the SIDE bridge, rooms, the x402 seller route and the Stellar adapter follow their own tracks.
