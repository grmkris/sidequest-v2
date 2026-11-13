---
status: accepted
date: 2026-11-13
---

# Rooms use NIP-17 behind one transport interface; Marmot stays a candidate

[ADR-0003](0003-nostr-native.md) left the room protocol to a spike with a fixed rule: Marmot (MLS over Nostr) is chosen only if it passes all eight criteria, otherwise rooms use NIP-17. The spike ran on 13 November 2026 against a local relay with throwaway keys, measuring both protocols on the same items. Marmot passed five and failed three.

## Decision

1. **Rooms use NIP-17** private messages (NIP-44 encryption, NIP-59 gift wraps), one wrap per member per message.
2. **Rooms are built behind one `RoomTransport` interface**: publish identity, create, add, remove, send, poll, members, disclose. Nothing above it names a protocol, so Marmot can replace NIP-17 later.
3. **The room layer is the membership authority.** NIP-17 has no group state: a message's recipients are its members. The room's id and its two founding members come from the job (`roomIdOf`).
4. **Every room message carries its own ordering key.** Messages sent in the same second come back in relay order, not send order, under both protocols.
5. **Readers poll with a look-back of two days and fifteen minutes**, deduplicating by wrap id. Gift wraps are backdated by up to two days, so a plain cursor misses about half of them.
6. **Evidence is a disclosed seal.** A member proves one message to the arbitrator by handing over the author-signed seal and that message's NIP-44 keys. The conversation key, and every other message, stay private.

## What the spike measured

| #   | Criterion                                                     | Marmot (marmot-ts 0.9.0)                                                                        | NIP-17                                              |
| :-- | :------------------------------------------------------------ | :---------------------------------------------------------------------------------------------- | :-------------------------------------------------- |
| 1   | Chromium, Firefox and WebKit; add and remove a member; reload | Pass                                                                                            | Pass                                                |
| 2   | A member inside workerd (the agent gateway's case)            | Pass; 3–5 ms per message                                                                        | Pass; 9–11 ms per copy read, 22–39 ms per send      |
| 3   | Interop with the current MDK release (v0.16.0), both ways     | Pass, when the relay advertises its result limit                                                | Not applicable                                      |
| 4   | 48 hours offline, caught up by polling alone                  | Pass, unless a relay pruned a membership change that was missed: then nothing later can be read | Pass with the two-day look-back                     |
| 5   | A second device on the same key                               | **Fail**: the MLS library refuses a second member with the same identity                        | Pass, history included                              |
| 6   | Lazy browser chunk of at most 150 KB gzip                     | **Fail**: 185 KiB, 161 KiB at best                                                              | Pass: 24 KiB                                        |
| 7   | One message proven to an outsider, exposing no other          | Pass, through internals the library does not export                                             | Pass                                                |
| 8   | A versioned, stable specification                             | **Fail**: no version or tag, 50 commits in 30 days, the library says "Alpha"                    | Pass: merged NIPs, a version byte in the ciphertext |

## Consequences

- **No forward secrecy and no post-compromise security.** A leaked Nostr key exposes every room message it ever received. Marmot would give both.
- **Relays see who receives room messages and when.** Members' inbox relays (kind 10050) should require authentication to read gift wraps; new users default to relays that do.
- **Sending costs one wrap per member**, which is fine for rooms of two to six.
- **A removed member is removed by convention**: later messages are not wrapped for them. Nothing is re-keyed.
- **A pruned wrap loses one message**, not the room.

## When to look again

Marmot replaces NIP-17 behind the same interface once all of these hold:

- a second device on the same key joins and reads in an unpatched marmot-ts;
- the specification has a version that marmot-ts and MDK both claim;
- the room chunk is at most 150 KB gzip;
- there is a way back from a missed, pruned membership change;
- marmot-ts exposes what a disclosure needs.

## Considered options

- **Marmot now, with the library patched.** A one-line patch makes the second device join. Rejected: the specification's multi-device work is still draft, and a patched alpha library would carry people's conversations.
