import { foldJob, type JobEvent, type JobView } from '@sidequest/fold'
import { EventId, type NostrEvent } from '@sidequest/nostr'
import {
  agentGrant,
  deliveryNote,
  grantRevocation,
  jobAccept,
  jobProposal,
  jobRequest,
  type KindSpec,
  parseSidequestEvent,
  statement,
} from '@sidequest/nostr/vocabulary'
import type { AccountRef, AgentGrantView, Cursor, Person, TypedData } from '@sidequest/protocol'
import { Effect, Layer, Option, Schema } from 'effect'
import { Core, CoreRefused, type CoreService } from '../src/Core/Core.ts'

// The core as an in-memory double: what the gateway reads and publishes through, answered from the events it was sent
// and what a test sets. Events are verified and read with the same vocabulary the core's index uses, jobs are folded
// by the same fold, and grants carry the index's statuses. It is not the core: the native test proves the real one.

/** What a test sets on the double: verified wallets per key, funded jobs, and a refusal the next publish answers. */
export interface CoreDouble {
  readonly events: Array<NostrEvent>
  readonly wallets: Map<string, ReadonlyArray<AccountRef>>
  readonly funded: Map<string, string>
  readonly nextPublish: { refusal: CoreRefused | undefined }
  readonly layer: Layer.Layer<Core>
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

/** An event read as a kind, or nothing. Reading a proposal recomputes its terms digest, which is asynchronous. */
const asKind = <C>(spec: KindSpec<C>, event: NostrEvent) => Effect.option(parseSidequestEvent(spec, event))

/** What the double's events say, read once per call: the jobs' events and every grant with its status now. */
interface Readings {
  readonly jobEvents: ReadonlyArray<JobEvent>
  readonly grants: ReadonlyArray<AgentGrantView>
}

const readEvent = (event: NostrEvent) =>
  Effect.all({
    request: asKind(jobRequest, event),
    proposal: asKind(jobProposal, event),
    accept: asKind(jobAccept, event),
    deliveryNote: asKind(deliveryNote, event),
    statement: asKind(statement, event),
    grant: asKind(agentGrant, event),
    revocation: asKind(grantRevocation, event),
  })

const readAll = (events: ReadonlyArray<NostrEvent>): Effect.Effect<Readings> =>
  Effect.map(Effect.forEach(events, readEvent), (read) => {
    const jobEvents = read.flatMap((each): ReadonlyArray<JobEvent> => [
      ...Option.toArray(Option.map(each.request, (parsed): JobEvent => ({ type: 'request', parsed }))),
      ...Option.toArray(Option.map(each.proposal, (parsed): JobEvent => ({ type: 'proposal', parsed }))),
      ...Option.toArray(Option.map(each.accept, (parsed): JobEvent => ({ type: 'accept', parsed }))),
      ...Option.toArray(Option.map(each.deliveryNote, (parsed): JobEvent => ({ type: 'deliveryNote', parsed }))),
      ...Option.toArray(Option.map(each.statement, (parsed): JobEvent => ({ type: 'statement', parsed }))),
    ])
    const revoked = new Set(
      read.flatMap((each) =>
        Option.toArray(Option.map(each.revocation, ({ event, content }) => `${content.grant}:${event.pubkey}`)),
      ),
    )
    const now = nowSeconds()
    const grants = read.flatMap((each) =>
      Option.toArray(
        Option.map(each.grant, ({ event, content }): AgentGrantView => {
          const status = revoked.has(`${event.id}:${event.pubkey}`)
            ? 'revoked'
            : now < content.notBefore
              ? 'notYet'
              : now < content.expiresAt
                ? 'active'
                : 'expired'
          return { event: event.id, operator: event.pubkey, ...content, status }
        }),
      ),
    )
    return { jobEvents, grants }
  })

/** The fold's view, with the double's funded jobs marked as the chain would make them. */
const viewOf = (readings: Readings, funded: ReadonlyMap<string, string>, id: string) =>
  Option.map(
    Option.flatMap(Schema.decodeUnknownOption(EventId)(id), (job) =>
      foldJob({ job, events: readings.jobEvents, chain: [], walletLinks: [], now: nowSeconds() }),
    ),
    (view): JobView => {
      const proposal = funded.get(id)
      const fundedProposal = view.proposals.find(({ id: candidate }) => candidate === proposal)
      if (fundedProposal === undefined) return view
      return {
        ...view,
        stage: 'funded',
        worker: fundedProposal.author,
        proposals: view.proposals.map((each) => ({ ...each, funded: each.id === proposal })),
      }
    },
  )

/** Typed data as the core answers it for a worker's delivery; its values are a fixture. */
const deliveryTypedData = (job: string, deliveryHash: string): TypedData => ({
  domain: { name: 'SidequestOperator', version: '1', chainId: 5042002, verifyingContract: `0x${'11'.repeat(20)}` },
  types: {
    Delivery: [
      { name: 'jobId', type: 'bytes32' },
      { name: 'deliveryHash', type: 'bytes32' },
    ],
  },
  primaryType: 'Delivery',
  message: { jobId: `0x${job}`, deliveryHash },
})

/** The last page's cursor. */
const noCursor: Cursor | null = null

/** A fresh double. */
export const coreDouble = (): CoreDouble => {
  const events: Array<NostrEvent> = []
  const wallets = new Map<string, ReadonlyArray<AccountRef>>()
  const funded = new Map<string, string>()
  const nextPublish: { refusal: CoreRefused | undefined } = { refusal: undefined }
  const person = ({ grants }: Readings, pubkey: string): Option.Option<Person> => {
    const agents = grants.filter(({ operator }) => operator === pubkey)
    const operators = grants.filter(({ agent, status }) => agent === pubkey && status !== 'revoked')
    const linked = (wallets.get(pubkey) ?? []).map((account) => ({
      account,
      event: '00'.repeat(32),
      issuedAt: 0,
      verification: 'verified' as const,
    }))
    if (agents.length + operators.length + linked.length === 0) return Option.none()
    const empty = { profile: null, relays: null, messagingRelays: null, unverifiedWallets: [] }
    return Option.some({ pubkey, ...empty, wallets: linked, agents, operators })
  }
  const service: CoreService = {
    publish: (event) =>
      Effect.suspend(() => {
        const refusal = nextPublish.refusal
        nextPublish.refusal = undefined
        if (refusal !== undefined) return Effect.fail(refusal)
        const duplicate = events.some(({ id }) => id === event.id)
        if (!duplicate) events.push(event)
        return Effect.succeed({ id: event.id, status: duplicate ? ('duplicate' as const) : ('stored' as const) })
      }),
    person: (pubkey) => Effect.map(readAll(events), (readings) => person(readings, pubkey)),
    openJobs: () =>
      Effect.map(readAll(events), (readings) => ({
        items: readings.jobEvents.flatMap((event) =>
          event.type === 'request' && !funded.has(event.parsed.event.id)
            ? [
                {
                  job: event.parsed.event.id,
                  buyer: event.parsed.event.pubkey,
                  createdAt: event.parsed.event.created_at,
                  request: event.parsed.content,
                  expired: false,
                  proposals: 0,
                },
              ]
            : [],
        ),
        next: noCursor,
      })),
    job: (id) => Effect.map(readAll(events), (readings) => viewOf(readings, funded, id)),
    listings: () => Effect.succeed({ items: [], next: null }),
    payment: () =>
      Effect.succeed({
        escrow: '0x0000000000000000000000000000000000000001',
        paymentHash: null,
        chainTime: nowSeconds(),
        stage: 'Unfunded',
        outcome: null,
        relayed: [],
      }),
    deliveryToSign: (job, deliveryHash) =>
      funded.has(job)
        ? Effect.succeed(deliveryTypedData(job, deliveryHash))
        : Effect.fail(new CoreRefused({ refusal: 'IndexSettlementRefused', reason: 'NotFunded' })),
  }
  return { events, wallets, funded, nextPublish, layer: Layer.succeed(Core, Core.of(service)) }
}

/** The events of a kind the double holds, read. */
export const eventsOfKind = <C>(double: CoreDouble, spec: KindSpec<C>) =>
  Effect.runPromise(
    Effect.map(
      Effect.forEach(double.events, (event) => asKind(spec, event)),
      (read) => read.flatMap(Option.toArray),
    ),
  )
