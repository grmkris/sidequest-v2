# Architecture

Sidequest v2 uses one public Cloudflare origin, an Alchemy-managed Worker, a Foldkit website and typed Effect boundaries. D1/Drizzle is the relational persistence seam; Durable Objects/Alchemy Domain remain available for future authoritative aggregates; R2 is the future artifact store.

The browser imports protocol contracts and browser-safe services only. HTTP, MCP and durable jobs will call shared typed operations. Chain settlement remains a future adapter boundary and is not part of this foundation.
