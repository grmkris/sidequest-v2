import { it } from '@effect/vitest'
import { publicKeyOf, type SecretKey } from '@sidequest/nostr'
import { buildSidequestEvent, erc8004Claim } from '@sidequest/nostr/vocabulary'
import { Effect, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { claimStatus, Erc8004Identities, registrationPath, type TokenFact } from '../src/Erc8004/Identities.ts'
import { EventStore } from '../src/Index/EventStore.ts'
import { Ingest } from '../src/Index/Ingest.ts'
import {
  alice,
  arrivalKeys,
  arrivalOrder,
  bob,
  carol,
  grant,
  indexWorld,
  linked,
  revocation,
  service,
  signed,
  walletOne,
} from './IndexWorld.ts'

// ERC-8004 identities in the index (ADR-0007, decision 5): claims are facts from events, token reads are facts from the
// chain, and whether a claim is verified is decided at the read. So every arrival order of the events and the reads,
// and a rebuild, must answer the same.

const at = 1_800_000_000
const registry = 'eip155:5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e'
const elsewhere = 'eip155:84532:0x8004a818bfb912233c491871b3d84c89a494bd9e'
const owner = walletOne.address.toLowerCase()
const site = 'https://sidequest.test'

const claim = (author: SecretKey, subject: SecretKey, agentId: string, createdAt: number, onRegistry = registry) =>
  signed(
    Effect.runSync(
      Effect.flatMap(
        Schema.decodeUnknownEffect(erc8004Claim.content)({
          subject: publicKeyOf(subject),
          registry: onRegistry,
          agentId,
          mcp: 'https://agents.sidequest.test/mcp',
        }),
        (content) => buildSidequestEvent(erc8004Claim, content, { createdAt }),
      ),
    ),
    author,
  )

// Alice's wallet one owns tokens 0 to 3. She claims token 0 for her agent Carol and token 1 for herself; Bob claims
// token 0 for Carol too (he owns nothing). Alice claims token 2 for Bob, whom she never granted, and token 3 for the
// service, granted, though its URI is another file. Token 9 does not exist. A claim on another registry is never read.
const aliceLinked = await linked(alice, walletOne, at)
const aliceToCarol = grant(alice, carol, { createdAt: at, notBefore: at, expiresAt: at + 1000 })
const aliceToService = grant(alice, service, { createdAt: at, notBefore: at, expiresAt: at + 1000 })
const events = [
  aliceLinked,
  aliceToCarol,
  aliceToService,
  claim(alice, carol, '0', at + 1),
  claim(bob, carol, '0', at + 2),
  claim(alice, alice, '1', at + 3),
  claim(alice, bob, '2', at + 4),
  claim(alice, service, '3', at + 5),
  claim(alice, carol, '9', at + 6),
  claim(alice, carol, '0', at + 7, elsewhere),
]

const fileOf = (key: SecretKey) => `${site}${registrationPath(publicKeyOf(key))}`
const token = (agentId: string, fields: Partial<TokenFact> = {}): TokenFact => ({
  registry,
  agentId,
  owner,
  agentUri: '',
  block: 10,
  ...fields,
})
const reads = [
  token('0', { agentUri: fileOf(carol) }),
  token('1', { agentUri: fileOf(alice) }),
  token('2', { agentUri: fileOf(bob) }),
  token('3', { agentUri: 'https://elsewhere.test/agent.json' }),
  token('9', { owner: null }),
  // An older read, recorded last in some orders, never replaces a later one.
  token('0', { owner: `0x${'99'.repeat(20)}`, agentUri: fileOf(carol), block: 5 }),
]

const keys: ReadonlyArray<SecretKey> = [alice, bob, carol, service]
const identitiesOfAll = Effect.flatMap(Erc8004Identities, (identities) =>
  Effect.forEach(keys, (key) => identities.of(publicKeyOf(key))),
)

const arrive = (pool: ReadonlyArray<unknown>, tokens: ReadonlyArray<TokenFact>) =>
  Effect.gen(function* () {
    const index = yield* Ingest
    const identities = yield* Erc8004Identities
    for (const event of pool) yield* index.ingest(event, 'publish')
    for (const fact of tokens) yield* identities.record(fact, at)
  })

const inWorld = <A, E>(effect: Effect.Effect<A, E, Ingest | Erc8004Identities | EventStore>) =>
  Effect.provide(effect, indexWorld().layer)

const statusOf = (
  identities: ReadonlyArray<{
    readonly agentId: string
    readonly registry: string
    readonly status: string
    readonly failure: string | null
  }>,
) =>
  identities.map(
    ({ registry: on, agentId, status, failure }) =>
      `${on === registry ? '' : 'elsewhere '}${agentId}: ${status}${failure === null ? '' : ` (${failure})`}`,
  )

describe('a claim’s status', () => {
  test('is decided by the first rule it fails, in order, once the token has been read', () => {
    const verified = { subject: 'aa'.repeat(32), block: 1, owner, ownerLinked: true, granted: true }
    const file = `${site}${registrationPath('aa'.repeat(32))}`
    expect(claimStatus({ ...verified, agentUri: file })).toEqual({ status: 'verified', failure: null })
    expect(claimStatus({ ...verified, block: null, agentUri: null })).toEqual({ status: 'unchecked', failure: null })
    expect(claimStatus({ ...verified, owner: null, agentUri: '' }).failure).toBe('noToken')
    expect(claimStatus({ ...verified, ownerLinked: false, granted: false, agentUri: '' }).failure).toBe(
      'ownerNotLinked',
    )
    expect(claimStatus({ ...verified, granted: false, agentUri: '' }).failure).toBe('notGranted')
    expect(claimStatus({ ...verified, agentUri: `${file}?x` }).status).toBe('verified')
    expect(claimStatus({ ...verified, agentUri: `${file}/` }).failure).toBe('otherUri')
    expect(claimStatus({ ...verified, agentUri: `ipfs://${file}` }).failure).toBe('otherUri')
    expect(claimStatus({ ...verified, agentUri: 'not a url' }).failure).toBe('otherUri')
  })
})

describe('ERC-8004 identities in the index', () => {
  const inOrder = Effect.runPromise(inWorld(Effect.andThen(arrive(events, reads), identitiesOfAll)))

  it.effect('verifies the owner’s claim for their agent and for themselves, and says why the others fail', () =>
    Effect.gen(function* () {
      const [ofAlice, ofBob, ofCarol, ofService] = yield* Effect.promise(() => inOrder)
      expect(statusOf(ofCarol ?? [])).toEqual(['0: verified', 'elsewhere 0: unchecked', '9: unverified (noToken)'])
      expect(ofCarol?.find((identity) => identity.agentId === '0' && identity.registry === registry)).toMatchObject({
        claimedBy: publicKeyOf(alice),
        mcp: 'https://agents.sidequest.test/mcp',
        readAtBlock: 10,
      })
      expect(statusOf(ofAlice ?? [])).toEqual(['1: verified'])
      expect(statusOf(ofBob ?? [])).toEqual(['2: unverified (notGranted)'])
      expect(statusOf(ofService ?? [])).toEqual(['3: unverified (otherUri)'])
    }),
  )

  it.effect.prop(
    'answers the same whatever order the events and the chain reads arrived in, and after a rebuild',
    [arrivalKeys(events.length), arrivalKeys(reads.length)],
    ([eventKeys, readKeys]) =>
      inWorld(
        Effect.gen(function* () {
          yield* arrive(arrivalOrder(events, eventKeys, 2), arrivalOrder(reads, readKeys, 1))
          const shuffled = yield* identitiesOfAll
          expect(shuffled).toEqual(yield* Effect.promise(() => inOrder))
          yield* Effect.flatMap(EventStore, (store) => store.rebuild)
          expect(yield* identitiesOfAll).toEqual(shuffled)
        }),
      ),
    { timeout: 60_000, arbitrary: { runs: 15 } },
  )

  it.effect('unverifies a claim when its grant is revoked, its wallet re-linked, or the token moves', () =>
    inWorld(
      Effect.gen(function* () {
        yield* arrive(events, reads)
        const identities = yield* Erc8004Identities
        const verifiedOf = (key: SecretKey) =>
          Effect.map(identities.of(publicKeyOf(key)), (found) =>
            statusOf(
              found.filter(
                (identity) =>
                  identity.registry === registry &&
                  identity.agentId !== '9' &&
                  identity.claimedBy === publicKeyOf(alice),
              ),
            ),
          )
        yield* Effect.flatMap(Ingest, (index) => index.ingest(revocation(alice, aliceToCarol.id, at + 20), 'publish'))
        expect(yield* verifiedOf(carol)).toEqual(['0: unverified (notGranted)'])
        yield* identities.record(token('1', { owner: `0x${'77'.repeat(20)}`, agentUri: fileOf(alice), block: 11 }), at)
        expect(yield* verifiedOf(alice)).toEqual(['1: unverified (ownerNotLinked)'])
        yield* identities.record(token('1', { agentUri: fileOf(alice), block: 12 }), at)
        expect(yield* verifiedOf(alice)).toEqual(['1: verified'])
        yield* Effect.flatMap(Ingest, (index) =>
          Effect.promise(() => linked(bob, walletOne, at + 30)).pipe(
            Effect.flatMap((event) => index.ingest(event, 'publish')),
          ),
        )
        expect(yield* verifiedOf(alice)).toEqual(['1: unverified (ownerNotLinked)'])
      }),
    ),
  )

  it.effect('counts a verified wallet link on any EVM chain, since it proves the same key’s address', () =>
    inWorld(
      Effect.gen(function* () {
        const onEthereum = yield* Effect.promise(() => linked(alice, walletOne, at, 1))
        yield* arrive([onEthereum, claim(alice, alice, '1', at + 3)], [token('1', { agentUri: fileOf(alice) })])
        expect(statusOf(yield* Effect.flatMap(Erc8004Identities, (found) => found.of(publicKeyOf(alice))))).toEqual([
          '1: verified',
        ])
      }),
    ),
  )

  it.effect('lists claims due a read on its registry: never read first, then the stalest, others never', () =>
    inWorld(
      Effect.gen(function* () {
        yield* arrive(events, [])
        const identities = yield* Erc8004Identities
        expect(yield* identities.due(registry, at, 10)).toEqual(
          ['0', '1', '2', '3', '9'].map((agentId) => ({ registry, agentId })),
        )
        yield* identities.record(token('0'), at - 100)
        yield* identities.record(token('1'), at)
        expect((yield* identities.due(registry, at - 50, 10)).map(({ agentId }) => agentId)).toEqual([
          '2',
          '3',
          '9',
          '0',
        ])
        expect(yield* identities.due(registry, at - 50, 2)).toHaveLength(2)
      }),
    ),
  )
})
