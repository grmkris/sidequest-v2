import { AccountRef, Hex32, NotIndexed, SidequestApi, Unavailable } from '@sidequest/protocol'
import { giveFeedbackCalldata, registerCalldata } from '@sidequest/settlement/Erc8004'
import { Effect, Layer, Option, Result, Schema } from 'effect'
import { isHex } from 'viem'
import * as HttpRouter from 'effect/http/HttpRouter'
import { HttpServerRequest } from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { HttpApiBuilder } from 'effect/http-api'
import { erc8004StageOf } from '../Erc8004/Erc8004Reader.ts'
import { entryDocument, feedbackTags } from '../Erc8004/Feedback.ts'
import { makeErc8004Files } from '../Erc8004/Files.ts'
import { registrationPath } from '../Erc8004/Identities.ts'
import { labelled, Moderation } from '../Index/Moderation.ts'
import { Settlement } from '../Settlement/Settlement.ts'
import { publicFor } from './EventsHttp.ts'

/**
 * The origin this request came to: the site's, since the edge forwards the request as it came, and every URL a file
 * names is on it. A Worker's request URL is absolute.
 */
const requestOrigin = Effect.flatMap(HttpServerRequest, (request) =>
  URL.canParse(request.originalUrl)
    ? Effect.succeed(new URL(request.originalUrl).origin)
    : Effect.fail(new Unavailable()),
)

const addressOf = (account: string) => account.slice(account.lastIndexOf(':') + 1)

/**
 * The `erc8004` group (ADR-0007): the stage's registries, a key's registration file (the `agentURI` its identity names,
 * cached five minutes), its feedback file (a minute), each labelled `hidden` when the stage's hide list covers the
 * key, as reads by id are; the feedback file, a list, leaves out hidden reviews and reviewers; and the calldata of the two transactions a wallet sends itself:
 * `register` for a key's file, and `giveFeedback` of one entry, which only that entry's client should send.
 */
export const erc8004Handlers = HttpApiBuilder.group(SidequestApi, 'erc8004', (handlers) =>
  Effect.gen(function* () {
    const files = yield* makeErc8004Files
    const moderation = yield* Moderation
    const stage = erc8004StageOf(yield* Settlement)
    const configured = Option.match(stage, {
      onNone: () => Effect.fail(new Unavailable()),
      onSome: Effect.succeed,
    })
    return handlers
      .handle('deployment', () =>
        Effect.gen(function* () {
          yield* publicFor(300)
          return Option.match(stage, {
            onNone: () => ({ chainId: null, identityRegistry: null, reputationRegistry: null }),
            onSome: ({ registries, identity }) => ({
              chainId: registries.chainId,
              identityRegistry: AccountRef.make(identity),
              reputationRegistry: AccountRef.make(
                `eip155:${registries.chainId}:${registries.reputation.toLowerCase()}`,
              ),
            }),
          })
        }),
      )
      .handle('registration', ({ params }) =>
        Effect.gen(function* () {
          const file = yield* files.registration(params.pubkey, yield* requestOrigin)
          if (Option.isNone(file)) return yield* new NotIndexed()
          yield* labelled(yield* moderation.covers([params.pubkey]))
          yield* publicFor(300)
          return file.value
        }),
      )
      .handle('registrationCall', ({ params }) =>
        Effect.gen(function* () {
          const { registries } = yield* configured
          const agentURI = `${yield* requestOrigin}${registrationPath(params.pubkey)}`
          return { chainId: registries.chainId, to: registries.identity, data: registerCalldata(agentURI), agentURI }
        }),
      )
      .handle('feedback', ({ params }) =>
        Effect.gen(function* () {
          const file = yield* files.feedback(params.pubkey, yield* requestOrigin)
          yield* labelled(yield* moderation.covers([params.pubkey]))
          yield* publicFor(60)
          return file
        }),
      )
      .handle('feedbackCall', ({ params }) =>
        Effect.gen(function* () {
          const { registries } = yield* configured
          const file = yield* files.feedback(params.pubkey, yield* requestOrigin)
          const item = file.items.find((found) => found.entry.sidequest.review.id === params.review)
          if (item === undefined || item.entry.agentId === undefined || !isHex(item.feedbackHash))
            return yield* new NotIndexed()
          const data = giveFeedbackCalldata({
            agentId: BigInt(item.entry.agentId),
            value: BigInt(item.entry.value),
            valueDecimals: item.entry.valueDecimals,
            ...feedbackTags,
            endpoint: '',
            feedbackUri: item.feedbackURI,
            feedbackHash: item.feedbackHash,
          })
          return {
            chainId: registries.chainId,
            to: registries.reputation,
            data,
            from: addressOf(item.entry.clientAddress),
          }
        }),
      )
  }),
)

/** `/api/erc8004/agents/:pubkey/feedback/:review`, its key and review as written. */
const entryPathPattern = /^\/api\/erc8004\/agents\/([^/]+)\/feedback\/([^/]+)$/u

/**
 * `GET /api/erc8004/agents/:pubkey/feedback/:review`: one entry of the key's feedback file alone, as the exact bytes
 * whose `keccak256` is its `feedbackHash` (RFC 8785 canonical JSON). Outside the typed API, which would encode the entry
 * in its own key order. 404 for a review that is no entry of the key's.
 */
export const erc8004EntryRoute = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter
    const files = yield* makeErc8004Files
    yield* router.add('GET', '/api/erc8004/agents/:pubkey/feedback/:review', (request) =>
      Effect.gen(function* () {
        const [, pubkey = '', review = ''] = entryPathPattern.exec(new URL(request.originalUrl).pathname) ?? []
        if (!Schema.is(Hex32)(pubkey) || !Schema.is(Hex32)(review)) return HttpServerResponse.empty({ status: 404 })
        const file = yield* files.feedback(pubkey, yield* requestOrigin)
        const item = file.items.find((found) => found.entry.sidequest.review.id === review)
        const document = item === undefined ? Result.fail(undefined) : entryDocument(item.entry)
        return Result.match(document, {
          onFailure: () => HttpServerResponse.empty({ status: 404 }),
          onSuccess: (text) =>
            HttpServerResponse.text(text, {
              contentType: 'application/json',
              headers: { 'cache-control': 'public, max-age=60' },
            }),
        })
      }).pipe(Effect.catchTag('Unavailable', () => Effect.succeed(HttpServerResponse.empty({ status: 503 })))),
    )
  }),
)
