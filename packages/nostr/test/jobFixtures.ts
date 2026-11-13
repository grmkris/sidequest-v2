import { AccountRef, NetworkRef, Terms, termsDigest } from '@sidequest/protocol'
import { Effect, Schema } from 'effect'
import { EventId } from '../src/Event.ts'
import { publicKeyOf } from '../src/Keys.ts'
import { alice, bob } from './fixtures.ts'

/** A buyer (alice) and a worker (bob) on Arc testnet, with terms in the registered USDC. */
export const buyer = publicKeyOf(alice)
export const worker = publicKeyOf(bob)
export const arcTestnet = NetworkRef.make('eip155:5042002')
export const otherNetwork = NetworkRef.make('eip155:1')
export const payTo = AccountRef.make('eip155:5042002:0x00000000000000000000000000000000000b0b00')
export const job = EventId.make('aa'.repeat(32))
export const proposalId = EventId.make('bb'.repeat(32))

export const terms = Schema.decodeSync(Terms)({
  title: 'Translate the onboarding guide',
  deliverables: ['Slovenian translation', 'Glossary of terms'],
  amount: '120000000',
  asset: 'eip155:5042002/erc20:0x3600000000000000000000000000000000000000',
  network: 'eip155:5042002',
  deliveryDeadline: 1_801_000_000,
  reviewWindowSeconds: 86_400,
  disputeWindowSeconds: 86_400,
  arbitrationWindowSeconds: 172_800,
  rail: 'escrow',
})

/** The digest of `terms`, computed once by the protocol package. */
export const digestOfTerms = await Effect.runPromise(termsDigest(terms))
