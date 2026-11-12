import {
  type AccountRef,
  type Digest,
  type JobId,
  type NetworkRef,
  AccountRef as AccountRefSchema,
} from '@sidequest/protocol'
import { Schema } from 'effect'
import { type Address, getAddress, type Hex, isAddress } from 'viem'

const crockford = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * A job id as the `bytes32 jobId` of its `JobParams`: the 128 bits of its ULID, right-aligned. The mapping is
 * one-to-one, so a `JobFunded` event names the Sidequest job it is for.
 */
export const jobIdWord = (job: JobId): Hex => {
  let value = 0n
  for (const character of job.slice(job.indexOf('_') + 1)) value = value * 32n + BigInt(crockford.indexOf(character))
  return `0x${value.toString(16).padStart(64, '0')}`
}

/** A terms digest (hex SHA-256) as the `bytes32 termsDigest` the operator stores. */
export const digestWord = (digest: Digest): Hex => `0x${digest}`

/** A `bytes32` word as a protocol digest: its 64 hex digits, lowercase. */
export const wordDigest = (word: Hex): string => word.slice(2).toLowerCase()

/** A wallet on `network` as CAIP-10, from its EVM address. */
export const accountRefOf = (network: NetworkRef, address: Address): AccountRef =>
  Schema.decodeSync(AccountRefSchema)(`${network}:${getAddress(address)}`)

/** The EVM address of a CAIP-10 account on `network`, if it is one. */
export const addressOn = (network: NetworkRef, account: AccountRef): Address | undefined => {
  if (!account.startsWith(`${network}:`)) return undefined
  const address = account.slice(network.length + 1)
  return isAddress(address, { strict: false }) ? getAddress(address) : undefined
}
