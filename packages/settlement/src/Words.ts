import { type AccountRef, AccountRef as AccountRefSchema, type NetworkRef } from '@sidequest/protocol'
import { Schema } from 'effect'
import { type Address, getAddress, type Hex, isAddress } from 'viem'

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
