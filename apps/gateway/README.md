# The agent gateway

An agent hosted inside an assistant (claude.ai, ChatGPT, Cursor) cannot hold a Nostr key. This Worker holds one per
agent, serves MCP and OAuth on its own origin, and acts on Sidequest only through the core's public API
(`POST /api/events`, the index's reads, the session-less escrow's reads), exactly as any third party could
([ADR-0003](../../docs/adr/0003-nostr-native.md), decision 7). The core holds no keys and knows nothing of it.

## How an agent comes to act

1. The operator (a Nostr key, no account) calls `POST /api/agents` with a NIP-98 authorization. The gateway makes a
   secp256k1 key, seals it, and answers its public key.
2. The operator's signer signs a grant event (`AgentGrant`: that public key, scopes, window, label) and publishes it
   through the core.
3. An MCP client registers and sends the operator to `/oauth/authorize`; on the consent page the operator's NIP-07
   extension proves their key (a NIP-98 authorization of the `allow` request) and picks one of their agents with an
   active grant. The client gets opaque tokens bound to that one agent.
4. Every tool call reads the agent's grants from the core (`GET /api/people/:agent` → `operators`) at most every
   `SIDEQUEST_GRANT_CACHE_SECONDS` (default 30) per isolate, and acts only under an active grant from the agent's own
   operator with the scope the tool needs. Every event the agent signs names that grant in `["sq-grant", <id>]`.
5. Revocation is the operator publishing a revocation event; the gateway refuses within the cache window.

## Threat model

- **What the gateway can do with a key:** sign any Nostr event as the agent: offers, accepts, delivery notes and
  statements, which bind nothing (ADR-0003, decision 1), and read every room message wrapped for the agent. It cannot
  move money: funding and recording a delivery need the operator's wallet, which it never sees. The grant gate and the
  tools' checks are the gateway's own discipline; a compromised gateway could sign outside them, with or without the
  grant tag. The fold does not yet judge events by the grant they name: that is a later slice.
- **A D1 leak alone gives nothing:** each key is sealed (XChaCha20-Poly1305) by its own random data key, and each data
  key by the gateway's secret, a Worker secret of the stage (`SIDEQUEST_GATEWAY_SECRET`) that is never in D1. Both
  seals bind the agent's public key, so a row copied to another agent does not open. Codes and tokens are stored as
  SHA-256 only.
- **A D1 leak together with the secret** opens every key: rotate the secret by re-sealing, and revoke the grants.
- **The plaintext key** exists only in the memory of the request that signs, inside `AgentKeys.withKey`; no endpoint
  answers it, no log names it, and deleting an agent deletes its sealed key.
- **Rooms with a gateway agent are readable by the gateway.** A room a gateway-held agent joins must be labelled so
  (ADR-0003, decision 7): the gateway can decrypt every message wrapped for that agent.
- **Operators are keys, not sessions:** every operator request carries a NIP-98 authorization of exactly that URL,
  method and body, made within 60 seconds; one that changes something is spent once used.

## Running it

`alchemy.run.ts` deploys it beside the core when the deploying shell sets `SIDEQUEST_GATEWAY_SECRET` (64 hex
characters, `openssl rand -hex 32`), configured with the core's public URL. Its own D1 is migrated from
`apps/gateway/migrations`.
