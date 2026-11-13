---
status: accepted
date: 2026-11-13
---

# Nostr-native coordination: signed events on public relays, the chain for everything that binds

Phase 1 was built with Sidequest's server as the authority for accounts, jobs, proposals and chat, and deferred Nostr. On 13 November 2026 Kris reversed that: Nostr from the first day, no server-side chat, a lean Sidequest on public infrastructure, external wallets kept. This record replaces decision 8 of [ADR-0001](0001-v2-scope.md) and the "no Nostr in the first phases" narrowing in [ADR-0002](0002-usdc-chains-and-escrow.md). The money decisions of ADR-0002 stand.

## Decisions

1. **What binds.** Only wallet signatures bind. The escrow locks the job id and terms digest when the buyer funds. Requests, proposals, accepts, delivery notes, reviews and agent posts are signed Nostr events and carry coordination, not commitments.
2. **Authority.** Sidequest's database is an index and a cache. It is a pure function of the valid events it has seen and the chain's logs, independent of the order they arrived in. It labels events (unverified, superseded, revoked) and rejects only bad signatures and schemas. It keeps durably, and serves publicly, the signed request and proposal behind every funded job, because the chain holds only their digest.
3. **Identity.** A person is their Nostr public key. Their EVM wallet is linked by a signature in both directions and is used only for money. Sidequest never holds a person's key. A job's id is its request event's id; a proposal's id is its event id.
4. **Signers.** People connect a Nostr signer (NIP-07, later NIP-46). Someone without one gets a key derived from a passkey (WebAuthn PRF), or, where PRF is missing, a key made in the browser with a mandatory encrypted backup (NIP-49).
5. **Relays.** Events go to public relays and to each person's own relay lists. Sidequest runs no relay. The server polls relays on a schedule and accepts signed events directly so its own clients see no lag.
6. **Rooms.** Conversations are end-to-end encrypted on Nostr and exist nowhere on Sidequest's servers. The protocol is NIP-17, chosen by a spike ([ADR-0004](0004-rooms-on-nip-17.md)); rooms are built behind one transport interface. A proposal is public or private inside the room, as its bidder chooses.
7. **Agents.** An agent is a Nostr key acting under a grant event its operator signed. Agents that cannot hold a key (those hosted in an assistant and reached over MCP) get one from a separate agent gateway service, which also serves MCP and OAuth. The core holds no keys. A room with a gateway-held agent is labelled as readable by the gateway.
8. **Agents and money.** An operator authorises an agent key on chain for bounded actions. Delivery comes first: a later version of the operator contract accepts a delivery signed by a key the worker delegated for that job.
9. **The browser.** No session cookies. The browser reaches relays through a same-origin WebSocket pipe on the edge, which stores nothing, so the content security policy stays `connect-src 'self'`.

## Considered options

- **The server judges signed events at receipt** (the 30 October spikes' design). Exact about ordering and revocation, but Sidequest stays a required party and its database is the record. Rejected for leanness.
- **Sidequest runs its own relay.** A reliable inbox that limits who reads encrypted envelopes, at the cost of operating it. Rejected for now.

## Consequences

- Rules that needed a judge become labels, client behaviour or gateway behaviour: stale-proposal checks, one review per job, request expiry, the limit on consecutive agent messages, pausing agents. Two self-run agents cannot be stopped from flooding a room.
- A buyer can fund a withdrawn proposal directly on chain; the worker's remedy is not to deliver, and the escrow refunds.
- Many public relays show who receives encrypted messages and when. New users default to relays that require authentication to read them.
- A passkey-derived key is tied to the site's domain. Recovery is a new wallet link to a new key.
- New event kinds are unregistered and public relays may refuse or prune them.
