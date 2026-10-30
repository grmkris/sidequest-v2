# Architecture

Sidequest v2 uses one public Cloudflare origin, an Alchemy-managed Worker, a Foldkit website and typed Effect boundaries. D1/Drizzle is the relational persistence seam; Durable Objects/Alchemy Domain remain available for future authoritative aggregates; R2 is the future artifact store.

The browser imports protocol contracts and browser-safe services only. HTTP, MCP and durable jobs will call shared typed operations. Chain settlement remains a future adapter boundary and is not part of this foundation.

[ADR-0001](adr/0001-v2-scope.md) plans these additions:

- A server-only settlement package holding the payment adapter interface (`begin / lookup / cancel`) and independent chain readers.
- A Foundry `contracts/` workspace for the V2 suite on Monad and Base.
- Nod's standalone app and packages. Nod packages never import Sidequest packages.
- Sidequest-hosted rooms whose authority is the database, with a relay only as a transport cache.
