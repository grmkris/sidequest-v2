import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { Option } from 'effect'
import { attempt } from './Attempt.ts'
import { bytesOf, hexOf } from './Hex.ts'
import type { PublicKey, SecretKey } from './Keys.ts'

// A Nostr key as an EVM key, so that an agent's key can sign as the delegate of a worker's delivery
// (`SidequestOperator.deliverDelegated`) without a second key to keep.
//
// Both are secp256k1. A Nostr public key is BIP-340's x-only key: the x coordinate of d·G, standing for the point with
// that x and an EVEN y (BIP-340 signs with n − d when d·G has an odd y). The EVM key of a Nostr key is that same
// even-y point, so it is the scalar
//
//     d' = d       when d·G has an even y,
//     d' = n − d   otherwise,
//
// and its address is the last 20 bytes of keccak256(x ‖ y) of the even-y point. It follows from the public key
// alone: anyone holding an agent's Nostr public key (the operator, the website, the index) computes the address the
// gateway will sign as, and the gateway signs with d'. An EVM wallet imported with the raw d would have another
// address half of the time; that is why the scalar is normalised.

const curveOrder = secp256k1.CURVE.n

/** The scalar of `secret` whose point has an even y: the key Ethereum sees for a Nostr key. */
const evenScalar = (secret: SecretKey) => {
  const scalar = BigInt(`0x${secret}`)
  return secp256k1.ProjectivePoint.BASE.multiply(scalar).toAffine().y % 2n === 0n ? scalar : curveOrder - scalar
}

const addressOfPoint = (uncompressed: Uint8Array): `0x${string}` =>
  `0x${hexOf(keccak_256(uncompressed.subarray(1)).subarray(12))}`

/**
 * The EVM address (lowercase `0x` hex) of a Nostr public key: the address of the even-y point BIP-340 assigns to it.
 * A valid public key always lifts to a point; one that does not (which `PublicKey` never admits) answers `None`.
 */
export const evmAddressOf = (publicKey: PublicKey): Option.Option<`0x${string}`> =>
  Option.map(
    attempt(() => secp256k1.ProjectivePoint.fromHex(`02${publicKey}`).toRawBytes(false)),
    addressOfPoint,
  )

/**
 * An Ethereum signature (65 bytes `r ‖ s ‖ v`, low `s`, `v` 27 or 28, as `ecrecover` and OpenZeppelin's `ECDSA` take
 * it) of a 32-byte digest by the EVM key of `secret`: deterministic (RFC 6979), recovering to `evmAddressOf` of its
 * public key. `None` for a digest that is not `0x` and 64 hex digits.
 */
export const signDigestAsEvm = (digest: string, secret: SecretKey): Option.Option<`0x${string}`> => {
  if (!/^0x[0-9a-fA-F]{64}$/u.test(digest)) return Option.none()
  const signature = secp256k1.sign(bytesOf(digest.slice(2)), evenScalar(secret), { lowS: true })
  return Option.some(`0x${hexOf(signature.toCompactRawBytes())}${(27 + signature.recovery).toString(16)}`)
}

const utf8 = (text: string) => new TextEncoder().encode(text)
const keccak = (...parts: Array<Uint8Array>) => keccak_256(concatBytes(...parts))
const word = (value: bigint) => bytesOf(value.toString(16).padStart(64, '0'))

const domainType = keccak(utf8('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'))
const deliveryType = keccak(utf8('Delivery(bytes32 paymentInfoHash,bytes32 deliveryHash)'))

/** Where a `SidequestOperator` checks a delivery: its chain and address, and the payment and delivered artefact. */
export interface OperatorDelivery {
  readonly chainId: number
  readonly operator: string
  readonly paymentInfoHash: string
  readonly deliveryHash: string
}

const address = /^0x[0-9a-fA-F]{40}$/u
const bytes32 = /^0x[0-9a-fA-F]{64}$/u

/**
 * The EIP-712 digest of `SidequestOperator`'s `Delivery(bytes32 paymentInfoHash,bytes32 deliveryHash)` in its domain
 * `{name: "SidequestOperator", version: "1", chainId, verifyingContract: operator}`, as `deliveryDigest` computes it:
 * what a worker, or the delegate of their delivery, signs. `None` for a malformed address or word.
 */
export const operatorDeliveryDigest = (delivery: OperatorDelivery): Option.Option<`0x${string}`> => {
  const { chainId, operator, paymentInfoHash, deliveryHash } = delivery
  if (!address.test(operator) || !bytes32.test(paymentInfoHash) || !bytes32.test(deliveryHash)) return Option.none()
  if (!Number.isSafeInteger(chainId) || chainId < 0) return Option.none()
  const domain = keccak(
    domainType,
    keccak(utf8('SidequestOperator')),
    keccak(utf8('1')),
    word(BigInt(chainId)),
    bytesOf(operator.slice(2).padStart(64, '0')),
  )
  const message = keccak(deliveryType, bytesOf(paymentInfoHash.slice(2)), bytesOf(deliveryHash.slice(2)))
  return Option.some(`0x${hexOf(keccak(Uint8Array.of(0x19, 0x01), domain, message))}`)
}
