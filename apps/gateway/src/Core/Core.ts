import { IndexJobsApi, type OpenJob } from '@sidequest/fold/api'
import type { JobView } from '@sidequest/fold'
import type { NostrEvent } from '@sidequest/nostr'
import {
  type Cursor,
  type DelegatedDelivery,
  EventsApi,
  type IndexListing,
  type EscrowPaymentStatus,
  EscrowApi,
  type Person,
  type Published,
  type TypedData,
} from '@sidequest/protocol'
import { Context, Effect, Layer, Option, Predicate, Schema } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { HttpApi } from 'effect/http-api'
import * as HttpApiClient from 'effect/http-api/HttpApiClient'
import { GatewaySettings } from '../Settings.ts'

// The core, as the gateway reaches it: only its public API, exactly as any third party could. Publishing a signed
// event (`POST /api/events`), the index's reads (people, listings, jobs as the fold shows them) and the session-less
// escrow's reads (payment status, the typed data a worker's wallet signs to record a delivery), and its relay of a
// delivery the agent's key signed under its operator wallet's delegation. Nothing here holds or sends a credential:
// every write is an event the agent's own key signed, or a delivery the contract checks the signatures of.

/** The part of the core's API the gateway calls. */
export class CoreApi extends HttpApi.make('core').add(EventsApi, IndexJobsApi, EscrowApi) {}

/**
 * The core refused what the gateway asked, and why, in the core's own words: its error's tag (`EventInvalid`,
 * `RateLimited`, `EscrowRefused`, ...) and, where it has one, its reason and detail.
 */
export class CoreRefused extends Schema.TaggedError<CoreRefused>()('CoreRefused', {
  refusal: Schema.String,
  reason: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
}) {}

/** The core did not answer, answered 503, or answered something the gateway could not read. */
export class CoreUnavailable extends Schema.TaggedError<CoreUnavailable>()('CoreUnavailable', {}) {}

export type CoreError = CoreRefused | CoreUnavailable

/** A page of the open requests, or of the listings a search matches. */
export interface PageQuery {
  readonly limit?: number | undefined
  readonly cursor?: Cursor | undefined
}

/** The core's services the gateway uses. `None` is the index's 404: it holds no such key or job. */
export interface CoreService {
  readonly publish: (event: NostrEvent) => Effect.Effect<Published, CoreError>
  readonly person: (pubkey: string) => Effect.Effect<Option.Option<Person>, CoreError>
  readonly openJobs: (
    page: PageQuery,
  ) => Effect.Effect<{ readonly items: ReadonlyArray<OpenJob>; readonly next: Cursor | null }, CoreError>
  readonly job: (id: string) => Effect.Effect<Option.Option<JobView>, CoreError>
  readonly listings: (
    query: PageQuery & { readonly q?: string | undefined; readonly tag?: string | undefined },
  ) => Effect.Effect<{ readonly items: ReadonlyArray<IndexListing>; readonly next: Cursor | null }, CoreError>
  readonly payment: (job: string) => Effect.Effect<EscrowPaymentStatus, CoreError>
  readonly deliveryToSign: (job: string, deliveryHash: string) => Effect.Effect<TypedData, CoreError>
  /**
   * Relays a delivery the agent's key signed as the delegate, with the operator wallet's delegation. The contract
   * checks both signatures; the core simulates first and answers the transaction.
   */
  readonly deliverDelegated: (
    job: string,
    delivery: DelegatedDelivery,
  ) => Effect.Effect<{ readonly transactionHash: string }, CoreError>
}

export class Core extends Context.Service<Core, CoreService>()('Sidequest/Gateway/Core') {}

/** The tags of the core's own refusals; anything else (transport, 5xx, an unreadable answer) is unavailability. */
const coreRefusals: ReadonlySet<string> = new Set([
  'EventInvalid',
  'KindNotIndexed',
  'EventTooLarge',
  'RateLimited',
  'BadCursor',
  'NotIndexed',
  'EscrowRefused',
])

const textField = (error: object, name: string): Option.Option<string> =>
  Predicate.hasProperty(error, name) && Predicate.isString(error[name]) ? Option.some(error[name]) : Option.none()

/** The core's error as the gateway reports it. */
export const coreErrorOf = (error: unknown): CoreError => {
  const tag = [...coreRefusals].find((name) => Predicate.isTagged(error, name))
  if (tag === undefined || !Predicate.isObject(error)) return new CoreUnavailable()
  const reason = textField(error, 'reason')
  const detail = textField(error, 'detail')
  return new CoreRefused({
    refusal: tag,
    ...(Option.isSome(reason) ? { reason: reason.value } : {}),
    ...(Option.isSome(detail) ? { detail: detail.value } : {}),
  })
}

/** A read whose 404 means the index holds nothing by that id. */
const orNone = <A, E, R>(read: Effect.Effect<A, E, R>) =>
  read.pipe(
    Effect.map(Option.some),
    Effect.catchIf(
      (error) => Predicate.isTagged(error, 'NotIndexed'),
      () => Effect.succeedNone,
    ),
    Effect.mapError(coreErrorOf),
  )

/** A page's query without the fields left out, as the typed client's optional keys want it. */
const pageOf = ({ limit, cursor }: PageQuery) => ({
  ...(limit === undefined ? {} : { limit }),
  ...(cursor === undefined ? {} : { cursor }),
})

/** The core over HTTP at the settings' `coreUrl`, through the typed client of its own API declaration. */
export const CoreLive = Layer.effect(
  Core,
  Effect.gen(function* () {
    const { coreUrl } = yield* GatewaySettings
    const client = yield* HttpApiClient.make(CoreApi, { baseUrl: coreUrl })
    return Core.of({
      publish: (event) => client.events.publish({ payload: event }).pipe(Effect.mapError(coreErrorOf)),
      person: (pubkey) => orNone(client.events.person({ params: { pubkey } })),
      openJobs: (page) =>
        client.indexJobs
          .openJobs({ query: { stage: 'open', expired: 'exclude', ...pageOf(page) } })
          .pipe(Effect.mapError(coreErrorOf)),
      job: (id) => orNone(client.indexJobs.job({ params: { id } })),
      listings: ({ q, tag, ...page }) =>
        client.events
          .listings({
            query: { ...pageOf(page), ...(q === undefined ? {} : { q }), ...(tag === undefined ? {} : { tag }) },
          })
          .pipe(Effect.mapError(coreErrorOf)),
      payment: (job) => client.escrow.payment({ params: { id: job } }).pipe(Effect.mapError(coreErrorOf)),
      deliveryToSign: (job, deliveryHash) =>
        client.escrow
          .deliveryToSign({ params: { id: job }, query: { deliveryHash } })
          .pipe(Effect.mapError(coreErrorOf)),
      deliverDelegated: (job, delivery) =>
        client.escrow.deliverDelegated({ params: { id: job }, payload: delivery }).pipe(Effect.mapError(coreErrorOf)),
    })
  }),
).pipe(Layer.provide(FetchHttpClient.layer))
