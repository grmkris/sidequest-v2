import { it } from '@effect/vitest'
import { Digest, UnixSeconds } from '@sidequest/protocol'
import { Effect, Equal, Option, Schema } from 'effect'
import { describe, expect } from 'vitest'
import { agentGrant, AgentGrantContent } from '../src/AgentGrant.ts'
import { deliveryNote, DeliveryNoteContent } from '../src/DeliveryNote.ts'
import { type Envelope, grantOf } from '../src/Envelope.ts'
import { EventId, type EventTemplate, type NostrEvent } from '../src/Event.ts'
import { grantRevocation, GrantRevocationContent } from '../src/GrantRevocation.ts'
import { jobAccept, JobAcceptContent } from '../src/JobAccept.ts'
import { jobProposal, type JobProposalContent } from '../src/JobProposal.ts'
import { jobRequest, JobRequestContent } from '../src/JobRequest.ts'
import { jobReview, JobReviewContent } from '../src/JobReview.ts'
import { publicKeyOf, type SecretKey } from '../src/Keys.ts'
import type { KindSpec } from '../src/KindSpec.ts'
import {
  type BuildOptions,
  buildSidequestEvent,
  parseSidequestEvent,
  type VocabularyRefused,
} from '../src/SidequestEvent.ts'
import { finalizeEvent } from '../src/Sign.ts'
import { statement, StatementContent } from '../src/Statement.ts'
import { walletLink } from '../src/WalletLink.ts'
import { alice, bob, GeneratedSecret, replaceAt, secret, zeros } from './fixtures.ts'
import { arcTestnet, buyer, digestOfTerms, job, otherNetwork, payTo, proposalId, terms, worker } from './jobFixtures.ts'

const createdAt = 1_800_000_000
type Extra = Omit<BuildOptions, 'createdAt'>

const sign = (template: EventTemplate, key: SecretKey = alice) => finalizeEvent(template, key, zeros)
const reasonOf = <A>(effect: Effect.Effect<A, { readonly reason: string }>) =>
  effect.pipe(
    Effect.map(() => 'accepted'),
    Effect.catch((error) => Effect.succeed(error.reason)),
  )

/** Builds, signs and parses; true when the parsed content and author are what went in. */
const roundTrips = <C>(spec: KindSpec<C>, content: C, key: SecretKey, extra: Extra = {}) =>
  Effect.gen(function* () {
    const template = yield* buildSidequestEvent(spec, content, { createdAt, ...extra })
    const parsed = yield* parseSidequestEvent(spec, sign(template, key))
    return Schema.toEquivalence(spec.content)(parsed.content, content) && parsed.event.pubkey === publicKeyOf(key)
  })

const proposalOf = (seed: { readonly job: EventId; readonly validUntil: number; readonly previous?: EventId }) => {
  const { previous, ...rest } = seed
  const content: JobProposalContent = { ...rest, buyer, terms, termsDigest: digestOfTerms, payTo }
  return previous === undefined ? content : { ...content, previous }
}

const ProposalSeed = Schema.Struct({ job: EventId, validUntil: UnixSeconds, previous: Schema.optionalKey(EventId) })
const WalletSeed = Schema.Struct({
  chain: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 99_999_999 })),
  address: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u)),
  issuedAt: UnixSeconds,
})
const walletContentOf = (seed: typeof WalletSeed.Type) =>
  Schema.decodeSync(walletLink.content)({
    address: `eip155:${seed.chain}:0x${seed.address}`,
    issuedAt: seed.issuedAt,
    walletSignature: `0x${'ab'.repeat(65)}`,
  })

describe('every Sidequest kind survives build, sign and parse', () => {
  it.effect.prop('request', [JobRequestContent, GeneratedSecret], ([content, key]) =>
    roundTrips(jobRequest, content, secret(key)),
  )
  it.effect.prop('proposal, on its terms’ network', [ProposalSeed, GeneratedSecret], ([seed, key]) =>
    roundTrips(jobProposal, proposalOf(seed), secret(key)),
  )
  it.effect.prop('accept, with its network', [JobAcceptContent, GeneratedSecret], ([content, key]) =>
    roundTrips(jobAccept, content, secret(key), { network: arcTestnet }),
  )
  it.effect.prop('delivery note, with its network', [DeliveryNoteContent], ([content]) =>
    roundTrips(deliveryNote, content, bob, { network: arcTestnet }),
  )
  it.effect.prop('statement, by an agent under a grant', [StatementContent, EventId], ([content, grant]) =>
    roundTrips(statement, content, bob, { grant }),
  )
  it.effect.prop('review', [JobReviewContent], ([content]) => roundTrips(jobReview, content, alice))
  it.effect.prop('grant', [AgentGrantContent], ([content]) => roundTrips(agentGrant, content, alice))
  it.effect.prop('revocation', [GrantRevocationContent], ([content]) => roundTrips(grantRevocation, content, alice))
  it.effect.prop('wallet link, on its account’s chain', [WalletSeed], ([seed]) =>
    roundTrips(walletLink, walletContentOf(seed), alice),
  )
})

/** A valid event of some kind, to tamper with, and the parser for its kind. */
interface Sample {
  readonly template: Effect.Effect<EventTemplate, VocabularyRefused>
  readonly parse: (input: unknown) => Effect.Effect<{ readonly envelope: Envelope }, VocabularyRefused>
}

const sample = <C>(spec: KindSpec<C>, content: C, extra: Extra = {}): Sample => ({
  template: buildSidequestEvent(spec, content, { createdAt, ...extra }),
  parse: (input) => parseSidequestEvent(spec, input),
})

const samples = [
  sample(jobRequest, {
    title: 'Logo',
    description: 'A small logo',
    expiresAt: createdAt,
    topics: ['design'],
    to: worker,
  }),
  sample(jobProposal, proposalOf({ job, validUntil: createdAt + 600 })),
  sample(jobAccept, { job, proposal: proposalId, termsDigest: digestOfTerms, worker }, { network: arcTestnet }),
  sample(deliveryNote, { job, buyer, deliveryHash: `0x${'cc'.repeat(32)}` }, { network: arcTestnet }),
  sample(statement, { job, about: proposalId, type: 'withdraw_proposal', text: 'Withdrawn' }),
  sample(jobReview, { job, subject: worker, rating: 5, text: 'On time' }, { grant: proposalId }),
  sample(agentGrant, {
    agent: worker,
    scopes: ['discuss'],
    notBefore: createdAt,
    expiresAt: createdAt + 1,
    label: 'Scout',
  }),
  sample(grantRevocation, { grant: proposalId }),
  sample(walletLink, walletContentOf({ chain: 5_042_002, address: '0b'.repeat(20), issuedAt: createdAt })),
]
const sampleAt = (index: number) => samples[index % samples.length] ?? sample(grantRevocation, { grant: proposalId })

const tamper: Record<string, (event: NostrEvent, position: number) => EventTemplate> = {
  drop: (event, position) => ({
    ...event,
    tags: event.tags.filter((_, index) => index !== position % event.tags.length),
  }),
  add: (event) => ({ ...event, tags: [...event.tags, ['t', 'extra']] }),
  alter: (event, position) => ({
    ...event,
    tags: event.tags.map((tag, index) =>
      index === position % event.tags.length
        ? tag.map((value, at) => (at === 1 ? replaceAt(value, position) : value))
        : tag,
    ),
  }),
  duplicate: (event, position) => ({ ...event, tags: [...event.tags, event.tags[position % event.tags.length] ?? []] }),
}

describe('a parser refuses what its content does not say', () => {
  it.effect.prop(
    // An author may name another network (where the network is theirs to name) or another grant: that parses, as what
    // it says. Anything else is refused.
    'refuses any kind’s event with a tag dropped, added, altered or repeated, even re-signed',
    [
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: samples.length - 1 })),
      Schema.Literals(['drop', 'add', 'alter', 'duplicate']),
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
    ],
    ([index, how, position]) =>
      Effect.gen(function* () {
        const { parse, template } = sampleAt(index)
        const original = sign(yield* template)
        const forged = sign(tamper[how]?.(original, position) ?? original)
        const { envelope } = yield* parse(original)
        const outcome = yield* parse(forged).pipe(
          Effect.map((parsed) =>
            Equal.equals(parsed.envelope.network, envelope.network) &&
            Equal.equals(parsed.envelope.grant, envelope.grant)
              ? 'accepted'
              : 'anotherEnvelope',
          ),
          Effect.catch((error) => Effect.succeed(error.reason)),
        )
        expect(['tagMismatch', 'badEnvelope', 'networkMismatch', 'anotherEnvelope']).toContain(outcome)
      }),
  )

  it.effect('refuses a routing tag that names someone the content does not', () =>
    Effect.gen(function* () {
      const { parse, template } = sampleAt(2)
      const event = sign(yield* template)
      const forged = sign({ ...event, tags: event.tags.map((tag) => (tag[0] === 'p' ? ['p', buyer] : tag)) })
      expect(yield* reasonOf(parse(forged))).toBe('tagMismatch')
    }),
  )

  it.effect('refuses a proposal whose digest is not its terms’, built or received', () =>
    Effect.gen(function* () {
      const wrong = Digest.make('00'.repeat(32))
      const content = { ...proposalOf({ job, validUntil: createdAt }), termsDigest: wrong }
      expect(yield* reasonOf(buildSidequestEvent(jobProposal, content, { createdAt }))).toBe('inconsistentContent')
      const honest = sign(
        yield* buildSidequestEvent(jobProposal, proposalOf({ job, validUntil: createdAt }), { createdAt }),
      )
      const forged = sign({ ...honest, content: honest.content.replace(digestOfTerms, wrong) })
      expect(yield* reasonOf(parseSidequestEvent(jobProposal, forged))).toBe('inconsistentContent')
    }),
  )

  it.effect('holds each kind to its network rule', () =>
    Effect.gen(function* () {
      const proposal = proposalOf({ job, validUntil: createdAt })
      const accept = { job, proposal: proposalId, termsDigest: digestOfTerms, worker }
      const request = { title: 'Logo', description: 'A small logo', expiresAt: createdAt }
      expect(yield* reasonOf(buildSidequestEvent(jobProposal, proposal, { createdAt, network: otherNetwork }))).toBe(
        'networkMismatch',
      )
      expect(yield* reasonOf(buildSidequestEvent(jobAccept, accept, { createdAt }))).toBe('networkMismatch')
      expect(yield* reasonOf(buildSidequestEvent(jobRequest, request, { createdAt, network: arcTestnet }))).toBe(
        'networkMismatch',
      )
      const built = yield* buildSidequestEvent(jobProposal, proposal, { createdAt })
      expect(built.tags).toContainEqual(['sq-net', arcTestnet])
      const moved = sign({
        ...built,
        tags: built.tags.map((tag) => (tag[0] === 'sq-net' ? ['sq-net', otherNetwork] : tag)),
      })
      expect(yield* reasonOf(parseSidequestEvent(jobProposal, moved))).toBe('networkMismatch')
    }),
  )

  it.effect('refuses another kind, content that is not its schema’s JSON, and a missing or other version', () =>
    Effect.gen(function* () {
      const revocation = sign(yield* buildSidequestEvent(grantRevocation, { grant: proposalId }, { createdAt }))
      expect(yield* reasonOf(parseSidequestEvent(agentGrant, revocation))).toBe('wrongKind')
      expect(yield* reasonOf(parseSidequestEvent(grantRevocation, sign({ ...revocation, content: '{' })))).toBe(
        'badContent',
      )
      const unversioned = sign({ ...revocation, tags: revocation.tags.filter((tag) => tag[0] !== 'sq') })
      expect(yield* reasonOf(parseSidequestEvent(grantRevocation, unversioned))).toBe('badEnvelope')
      const v1 = sign({ ...revocation, tags: revocation.tags.map((tag) => (tag[0] === 'sq' ? ['sq', '1'] : tag)) })
      expect(yield* reasonOf(parseSidequestEvent(grantRevocation, v1))).toBe('badEnvelope')
      expect(yield* reasonOf(parseSidequestEvent(grantRevocation, { ...revocation, content: '{}' }))).toBe(
        'invalidEvent',
      )
    }),
  )

  it.effect('reads the grant an agent acts under', () =>
    Effect.gen(function* () {
      const grant = EventId.make('dd'.repeat(32))
      const accept = { job, proposal: proposalId, termsDigest: digestOfTerms, worker }
      const event = sign(yield* buildSidequestEvent(jobAccept, accept, { createdAt, network: arcTestnet, grant }), bob)
      expect(grantOf(event)).toEqual(Option.some(grant))
      expect((yield* parseSidequestEvent(jobAccept, event)).envelope.grant).toEqual(Option.some(grant))
      expect(grantOf(sign({ ...event, tags: [...event.tags, ['sq-grant', grant]] }))).toEqual(Option.none())
    }),
  )
})
