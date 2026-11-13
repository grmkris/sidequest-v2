import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { Option } from 'effect'
import { attempt } from './Attempt.ts'
import { bytesOf, hexOf } from './Hex.ts'

const recoverable = /^0x[0-9a-fA-F]{130}$/u
const digestHex = /^0x[0-9a-fA-F]{64}$/u

/**
 * The EOA address (lowercase `0x` hex) whose key made a 65-byte `r ‖ s ‖ v` signature of a 32-byte digest, as
 * `ecrecover` does: `v` is 27 or 28 (or 0 or 1). `None` for anything else, including an ERC-1271 smart account's
 * signature, which only a call to the account can check.
 */
export const recoverAddress = (digest: string, signature: string): Option.Option<`0x${string}`> => {
  if (!recoverable.test(signature) || !digestHex.test(digest)) return Option.none()
  const bytes = bytesOf(signature.slice(2))
  const v = bytes[64] ?? 0
  const recovery = v >= 27 ? v - 27 : v
  if (recovery !== 0 && recovery !== 1) return Option.none()
  return Option.map(
    attempt(() =>
      secp256k1.Signature.fromCompact(bytes.subarray(0, 64))
        .addRecoveryBit(recovery)
        .recoverPublicKey(bytesOf(digest.slice(2)))
        .toRawBytes(false),
    ),
    (point): `0x${string}` => `0x${hexOf(keccak_256(point.subarray(1)).subarray(12))}`,
  )
}
