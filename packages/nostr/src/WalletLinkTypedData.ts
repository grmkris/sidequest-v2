import { keccak_256 } from '@noble/hashes/sha3.js'
import { concatBytes } from '@noble/hashes/utils.js'
import type { UnixSeconds } from '@sidequest/protocol'
import { bytesOf, hexOf } from './Hex.ts'
import type { PublicKey } from './Keys.ts'

/**
 * The EIP-712 typed data a wallet signs (`eth_signTypedData_v4`) to link a Nostr key: domain `Sidequest`, version
 * `1`, the wallet's chain, and `LinkNostrKey(bytes32 pubkey, uint64 issuedAt)`. No verifying contract: the link is a
 * statement, not a contract call. Integers are decimal strings so nothing loses precision on the way to the wallet.
 */
export const walletLinkTypedData = (pubkey: PublicKey, issuedAt: UnixSeconds, chainId: number) => ({
  domain: { name: 'Sidequest', version: '1', chainId },
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
    ],
    LinkNostrKey: [
      { name: 'pubkey', type: 'bytes32' },
      { name: 'issuedAt', type: 'uint64' },
    ],
  },
  primaryType: 'LinkNostrKey',
  message: { pubkey: `0x${pubkey}`, issuedAt: String(issuedAt) },
})

const utf8 = (text: string) => new TextEncoder().encode(text)

const word = (value: number) => bytesOf(BigInt(value).toString(16).padStart(64, '0'))

const keccak = (...parts: Array<Uint8Array>) => keccak_256(concatBytes(...parts))

const domainType = keccak(utf8('EIP712Domain(string name,string version,uint256 chainId)'))
const linkType = keccak(utf8('LinkNostrKey(bytes32 pubkey,uint64 issuedAt)'))

/** The EIP-712 digest the wallet signs: `keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(message))`, as `0x` hex. */
export const walletLinkDigest = (pubkey: PublicKey, issuedAt: UnixSeconds, chainId: number): `0x${string}` => {
  const domain = keccak(domainType, keccak(utf8('Sidequest')), keccak(utf8('1')), word(chainId))
  const message = keccak(linkType, bytesOf(pubkey), word(issuedAt))
  return `0x${hexOf(keccak(Uint8Array.of(0x19, 0x01), domain, message))}`
}
