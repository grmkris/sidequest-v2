import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { type Bytes32, Digest } from '@sidequest/protocol'
import { Option, Schema } from 'effect'
import { EventId } from './Event.ts'
import { bytesOf, hexOf } from './Hex.ts'
import type { PublicKey } from './Keys.ts'

// The domain separates room ids from every other SHA-256 in Sidequest; the NUL ends it, and the fields after it are
// fixed-length, so no two rooms share an encoding.
const roomDomain = new TextEncoder().encode('sidequest/room/v1\u0000')

/**
 * A negotiation room's id: `sha256("sidequest/room/v1" ‖ 0x00 ‖ job ‖ buyer ‖ bidder)` over the 32-byte job event id
 * and x-only keys. Anyone who knows the three names the same room, so rooms are never minted.
 */
export const roomIdOf = (job: EventId, buyer: PublicKey, bidder: PublicKey): Digest =>
  // SHA-256 is always 32 bytes, so its hex always matches the schema.
  Digest.make(hexOf(sha256(concatBytes(roomDomain, bytesOf(job), bytesOf(buyer), bytesOf(bidder)))))

/** The escrow contract's `bytes32 jobId` for a job: its request event's id, with `0x`. */
export const jobIdWord = (job: EventId): Bytes32 => `0x${job}`

/** The job whose request event id a contract word is, for reading chain logs back. */
export const jobOfWord = (word: string): Option.Option<EventId> =>
  word.startsWith('0x') ? Schema.decodeUnknownOption(EventId)(word.slice(2)) : Option.none()
