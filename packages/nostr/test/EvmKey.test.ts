import { randomBytes } from 'node:crypto'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { Option, Schema } from 'effect'
import { hashTypedData, type Hex, recoverAddress as viemRecoverAddress } from 'viem'
import { privateKeyToAccount, publicKeyToAddress } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { evmAddressOf, operatorDeliveryDigest, signDigestAsEvm } from '../src/EvmKey.ts'
import { publicKeyOf, SecretKey } from '../src/Keys.ts'
import { recoverAddress } from '../src/RecoverAddress.ts'

// viem is the reference here, in the test only: the gateway signs with noble through `EvmKey.ts`, and what it signs
// must be exactly what an Ethereum library (and so `ecrecover`) makes of the same key.

const freshKey = () => Schema.decodeSync(SecretKey)(randomBytes(32).toString('hex'))
const hexKey = (scalar: bigint): Hex => `0x${scalar.toString(16).padStart(64, '0')}`

/** Whether the raw scalar's point has an odd y, so that BIP-340 (and the EVM key) use its negation. */
const oddY = (secret: SecretKey) => secp256k1.ProjectivePoint.fromPrivateKey(secret).toAffine().y % 2n === 1n

/** Keys until both parities were seen, at least `count`. */
const keys = (count: number) => {
  const found: Array<SecretKey> = []
  while (found.length < count || !found.some(oddY) || found.every(oddY)) found.push(freshKey())
  return found
}

describe('a Nostr key as an EVM key', () => {
  it('has the address of the even-y point its x-only public key names, computed from the public key alone', () => {
    for (const secret of keys(16)) {
      const scalar = BigInt(`0x${secret}`)
      const even = oddY(secret) ? secp256k1.CURVE.n - scalar : scalar
      const lifted = secp256k1.ProjectivePoint.fromHex(`02${publicKeyOf(secret)}`).toHex(false)
      const address = Option.getOrThrow(evmAddressOf(publicKeyOf(secret)))
      expect(address).toBe(privateKeyToAccount(hexKey(even)).address.toLowerCase())
      expect(address).toBe(publicKeyToAddress(`0x${lifted}`).toLowerCase())
      // The raw scalar is another account exactly when its point has an odd y: the reason for normalising.
      expect(address === privateKeyToAccount(`0x${secret}`).address.toLowerCase()).toBe(!oddY(secret))
    }
  })

  it('signs a digest exactly as viem signs it with that key, and recovers to that address', async () => {
    for (const secret of keys(12)) {
      const digest: Hex = `0x${randomBytes(32).toString('hex')}`
      const signature = Option.getOrThrow(signDigestAsEvm(digest, secret))
      const address = Option.getOrThrow(evmAddressOf(publicKeyOf(secret)))
      const scalar = BigInt(`0x${secret}`)
      const even = oddY(secret) ? secp256k1.CURVE.n - scalar : scalar
      expect(signature).toBe(await privateKeyToAccount(hexKey(even)).sign({ hash: digest }))
      expect((await viemRecoverAddress({ hash: digest, signature })).toLowerCase()).toBe(address)
      expect(recoverAddress(digest, signature)).toEqual(Option.some(address))
      expect(signature).toMatch(/^0x[0-9a-f]{128}(1b|1c)$/u)
    }
  })

  it('refuses to sign what is not a 32-byte digest', () => {
    const secret = freshKey()
    expect(signDigestAsEvm('0x12', secret)).toEqual(Option.none())
    expect(signDigestAsEvm('ab'.repeat(32), secret)).toEqual(Option.none())
  })
})

describe("SidequestOperator's Delivery digest", () => {
  const delivery = {
    chainId: 5042002,
    operator: '0x6AE5E129054a5dBFCeBb9Dfcb1CE1AA229fB1Ddb',
    paymentInfoHash: `0x${'66'.repeat(32)}`,
    deliveryHash: `0x${'2c'.repeat(32)}`,
  } as const

  it('is the EIP-712 digest viem computes for the same typed data', () => {
    const typed = {
      domain: {
        name: 'SidequestOperator',
        version: '1',
        chainId: delivery.chainId,
        verifyingContract: delivery.operator,
      },
      types: {
        Delivery: [
          { name: 'paymentInfoHash', type: 'bytes32' },
          { name: 'deliveryHash', type: 'bytes32' },
        ],
      },
      primaryType: 'Delivery',
      message: { paymentInfoHash: delivery.paymentInfoHash, deliveryHash: delivery.deliveryHash },
    } as const
    expect(operatorDeliveryDigest(delivery)).toEqual(Option.some(hashTypedData(typed)))
  })

  it('refuses a malformed operator, word or chain', () => {
    expect(operatorDeliveryDigest({ ...delivery, operator: '0x1234' })).toEqual(Option.none())
    expect(operatorDeliveryDigest({ ...delivery, deliveryHash: '0x12' })).toEqual(Option.none())
    expect(operatorDeliveryDigest({ ...delivery, chainId: -1 })).toEqual(Option.none())
  })
})
