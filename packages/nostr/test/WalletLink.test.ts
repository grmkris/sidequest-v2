import { it } from '@effect/vitest'
import { Effect, Option, Schema } from 'effect'
import { hashTypedData, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vitest'
import { PublicKey, publicKeyOf } from '../src/Keys.ts'
import { recoverAddress } from '../src/RecoverAddress.ts'
import { buildSidequestEvent, parseSidequestEvent } from '../src/SidequestEvent.ts'
import { finalizeEvent } from '../src/Sign.ts'
import { networkOfAccount, walletLink } from '../src/WalletLink.ts'
import { walletLinkDigest, walletLinkTypedData } from '../src/WalletLinkTypedData.ts'
import { alice, Hex32, zeros } from './fixtures.ts'

// viem is the reference: it hashes and signs the typed data the way wallets do, independently of this package.
const viemDigest = (pubkey: PublicKey, issuedAt: number, chainId: number) => {
  const typed = walletLinkTypedData(pubkey, issuedAt, chainId)
  return hashTypedData({
    domain: typed.domain,
    types: { LinkNostrKey: typed.types.LinkNostrKey },
    primaryType: 'LinkNostrKey',
    message: { pubkey: `0x${pubkey}`, issuedAt: BigInt(issuedAt) },
  })
}

const wallet = privateKeyToAccount(`0x${'42'.repeat(32)}`)
const issuedAt = 1_800_000_000
const arcChain = 5_042_002

describe('linking a wallet to a Nostr key', () => {
  it.prop(
    'hashes the typed data exactly as viem does',
    [
      Hex32,
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 ** 32 })),
    ],
    ([key, at, chainId]) =>
      walletLinkDigest(PublicKey.make(key), at, chainId) === viemDigest(PublicKey.make(key), at, chainId),
  )

  it.effect('recovers the wallet from its signature of the typed data, as the indexer will', () =>
    Effect.gen(function* () {
      const pubkey = publicKeyOf(alice)
      const typed = walletLinkTypedData(pubkey, issuedAt, arcChain)
      const signature = yield* Effect.promise(() =>
        wallet.signTypedData({
          domain: typed.domain,
          types: { LinkNostrKey: typed.types.LinkNostrKey },
          primaryType: 'LinkNostrKey',
          message: { pubkey: `0x${pubkey}`, issuedAt: BigInt(issuedAt) },
        }),
      )
      const address = `eip155:${arcChain}:${wallet.address.toLowerCase()}`
      const content = yield* Schema.decodeUnknownEffect(walletLink.content)({
        address,
        issuedAt,
        walletSignature: signature,
      })
      const event = finalizeEvent(
        yield* buildSidequestEvent(walletLink, content, { createdAt: issuedAt }),
        alice,
        zeros,
      )
      const parsed = yield* parseSidequestEvent(walletLink, event)
      expect(parsed.event.tags).toContainEqual(['i', address])
      expect(parsed.envelope.network).toEqual(Option.some(networkOfAccount(content.address)))
      const digest = walletLinkDigest(parsed.event.pubkey, parsed.content.issuedAt, arcChain)
      expect(recoverAddress(digest, parsed.content.walletSignature)).toEqual(Option.some(wallet.address.toLowerCase()))
    }),
  )

  test('recovers nothing from a signature that is not 65 bytes with v of 27 or 28', () => {
    const digest = viemDigest(publicKeyOf(alice), issuedAt, arcChain)
    const signature: Hex = `0x${'11'.repeat(64)}1d`
    expect(recoverAddress(digest, signature)).toEqual(Option.none())
    expect(recoverAddress(digest, `0x${'00'.repeat(65)}`)).toEqual(Option.none())
    expect(recoverAddress(digest, `0x${'11'.repeat(66)}`)).toEqual(Option.none())
    expect(recoverAddress('0x12', signature)).toEqual(Option.none())
  })

  test('refuses an account in mixed case, off EVM, or a signature that is not hex', () => {
    const decode = Schema.decodeUnknownOption(walletLink.content)
    const link = { address: `eip155:1:0x${'ab'.repeat(20)}`, issuedAt, walletSignature: '0xab' }
    expect(Option.isSome(decode(link))).toBe(true)
    expect(decode({ ...link, address: `eip155:1:0x${'AB'.repeat(20)}` })).toEqual(Option.none())
    expect(decode({ ...link, address: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:abc' })).toEqual(Option.none())
    expect(decode({ ...link, walletSignature: '0xabc' })).toEqual(Option.none())
  })
})
