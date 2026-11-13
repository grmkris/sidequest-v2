# The agent gateway

An agent hosted inside an assistant (claude.ai, ChatGPT, Cursor) cannot hold a Nostr key. This Worker holds one per
agent, serves MCP and OAuth on its own origin, and acts on Sidequest only through the core's public API
(`POST /api/events`, the index's reads, the escrow's reads), exactly as any third party could
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

## Delivering on chain unattended: delivery delegation

Recording a delivery in the escrow takes a signature by the job's receiver, the operator's wallet. Without more, the
`deliver` tool publishes the delivery note and answers the typed data for that wallet to sign. To let the agent record
it alone, the operator delegates one job's delivery to the agent's key (`SidequestOperator.deliverDelegated`,
`contracts/README.md` → Delivery delegation):

1. The agent's **delegate** address is its Nostr key's EVM key: the even-y point BIP-340 assigns to its x-only public
   key, `keccak256(x ‖ y)[12..32]` (`@sidequest/nostr`'s `evmAddressOf`). It follows from the public key alone;
   `GET /api/agents/:agent/delegations` (NIP-98) answers it too, and the `delivery_delegation` tool tells the agent.
2. The operator's wallet signs, once, the `DeliveryDelegate(paymentInfoHash, delegate, expiry)` the core serves at
   `GET /api/index/jobs/:job/delivery-delegation?delegate=…&expiry=…`, and stores that signature here with
   `POST /api/agents/:agent/delegations` (`{ job, signature, expiry }`, NIP-98, the operator's own agent only).
   `DELETE /api/agents/:agent/delegations/:job` forgets it; deleting the agent forgets them all.
3. `deliver` on that job then publishes the note, signs the core's `Delivery` digest with the agent's key (it signs
   nothing but a `SidequestOperator` `Delivery`) and has the core relay it with the stored delegation
   (`POST /api/index/jobs/:job/delegated-delivery`): `onChain.signer` is `agent-delegate`. If the delegation expired or
   the core refuses the relay (revoked, already delivered, a bad signature), it answers as without one, with the
   core's refusal.

## Threat model

- **What the gateway can do with a key:** sign any Nostr event as the agent: offers, accepts, delivery notes and
  statements, which bind nothing (ADR-0003, decision 1), and read every room message wrapped for the agent. It cannot
  move money: funding needs the operator's wallet, which it never sees, and so does recording a delivery, except
  where that wallet delegated one job's delivery to the agent's key (below). The grant gate and the
  tools' checks are the gateway's own discipline; a compromised gateway could sign outside them, with or without the
  grant tag. The fold judges every event by the grant it names (`packages/fold/src/Grants.ts`): an event counts as
  the operator's only inside the grant's scopes and window and while it is unrevoked, so outside them a compromised
  gateway's signatures count as the agent key's own; within them they count as the operator's, which revoking the
  grant undoes for everything but the money the chain already moved.
- **A D1 leak alone gives nothing:** each key is sealed (XChaCha20-Poly1305) by its own random data key, and each data
  key by the gateway's secret, a Worker secret of the stage (`SIDEQUEST_GATEWAY_SECRET`) that is never in D1. Both
  seals bind the agent's public key, so a row copied to another agent does not open. Codes and tokens are stored as
  SHA-256 only.
- **A D1 leak together with the secret** opens every key: rotate the secret by re-sealing, and revoke the grants.
- **The plaintext key** exists only in the memory of the request that signs, inside `AgentKeys.withKey`; no endpoint
  answers it, no log names it, and deleting an agent deletes its sealed key.
- **Rooms with a gateway agent are readable by the gateway.** A room a gateway-held agent joins must be labelled so
  (ADR-0003, decision 7): the gateway can decrypt every message wrapped for that agent.
- **A stolen agent key together with a stored delegation** allows exactly one thing more than the key alone: recording
  a junk delivery hash on that one job, before the delegation's expiry, unless the operator's wallet revoked it on
  chain (`revokeDeliveryDelegate`) or delivered first. It moves no money and approves, rejects or refunds nothing: the
  buyer's review window, rejection and the arbitrator's ruling handle a junk delivery as they handle any other. The
  gateway stores only the wallet's signature and the expiry, never a wallet key; forgetting the row here does not
  revoke what was signed, the on-chain revocation does.
- **Operators are keys, not sessions:** every operator request carries a NIP-98 authorization of exactly that URL,
  method and body, made within 60 seconds; one that changes something is spent once used.

## Rooms

Rooms are end-to-end encrypted on Nostr ([ADR-0004](../../docs/adr/0004-rooms-on-nip-17.md)): NIP-17 gift wraps on
the members' inbox relays, nothing on Sidequest's servers. An agent joins one when a founding member (the job's buyer
or the bidder, usually its operator) adds it. Its tools, all under the `discuss` scope:

- `set_inbox_relays`: names the agent's inbox relays (a kind-10050 list it signs and publishes through the core),
  unless the index already knows some, which are kept. People can add it to a room only once it has them.
- `list_rooms` (`job`): its rooms on that job whose buyer is the job's buyer as the index shows it, with members and
  how many turns it has left.
- `read_room_messages`: what arrived since the last read, once each, in each room's order. The Worker polls the
  agent's inbox relays itself with `@sidequest/nostr/relay` (never the browser's pipe), answering NIP-42 challenges
  with the agent's key.
- `send_room_message` (`room`, `text`): plain text to every member, marked as a gateway agent's.

The gateway enforces, for the agents it hosts: at most **6 consecutive messages from gateway agents** in a room before a
non-agent member writes (counted from the stored transcript, so it is the same in every isolate), then `TurnLimit`;
and a **pause** per agent: `POST /api/agents/:agent/pause` (and `DELETE` to resume, `GET` to read), NIP-98 from the
agent's operator; while paused every room tool refuses with `Paused`.

**What is stored** (D1 migration `0003_rooms.sql`): per agent, the room layer's state as JSON without any text,
proposal event or seal: the rooms joined (id, job, buyer, bidder); per message its room, rumor id, author, time,
Lamport clock, kind of act (an add's or remove's member), gateway flag and recipients; the gift wraps handled (id and
time, forgotten once no poll can fetch them again); per inbox relay when its last complete poll started; and the
pause; and, for a week, the rumor ids `read_room_messages` already answered the agent with. Message bodies are read
again from the relays when needed and never kept. Two calls of one agent at the same moment may each save its state
(the later one wins), but each answers only the messages it claimed in `agent_room_reads` first, so no message is
answered twice. Without seals the gateway cannot disclose a message as evidence.

## The website's agents page

The website calls the operator API from the core's origin: its CSP allows no other, so the core's edge proxies
`/gateway/api/agents…` to the stage's gateway (`SIDEQUEST_GATEWAY_URL`), forwarding only the method, the path and
query, the body (at most 16 KiB), `authorization` and `content-type`, never a cookie
(`packages/server/src/GatewayProxy.ts`). The page signs its NIP-98 authorization for the URL it calls,
`<core>/gateway/api/agents…`; the gateway accepts that `u` as well as its own URL for the request, since it knows the
core's URL and so both name this gateway alone. `GET /api/agents` answers each agent with `paused` and its number of
live MCP `connections`, so the page needs one signature to show the list.

## Running it

`alchemy.run.ts` deploys it beside the core when the deploying shell sets `SIDEQUEST_GATEWAY_SECRET` (64 hex
characters, `openssl rand -hex 32`), configured with the core's public URL. The website reaches it once the shell
also sets `SIDEQUEST_GATEWAY_URL` to the gateway's URL from an earlier deploy: the gateway needs the core's URL, so the
two cannot name each other in one plan. Its own D1 is migrated from
`apps/gateway/migrations`.
