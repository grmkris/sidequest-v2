import { NotIndexed, SidequestApi } from '@sidequest/protocol'
import { Effect, Option } from 'effect'
import type { HttpServerRequest } from 'effect/http/HttpServerRequest'
import { HttpApiBuilder } from 'effect/http-api'
import { getAddress, type Hex, isHex } from 'viem'
import { Jobs } from '../Index/Jobs.ts'
import { type Limit, RateLimiter } from '@sidequest/serving/RateLimiter'
import { requireArbitrationKey } from '../Escrow/Arbitration.ts'
import { keptTerms } from '../Escrow/KeptTerms.ts'
import { escrowSteps } from '../Escrow/EscrowSteps.ts'
import { EscrowSettings } from '../Escrow/EscrowSettings.ts'
import { clientAddress, publicFor } from './EventsHttp.ts'

/**
 * Each client address may make 30 escrow requests a minute. A person signs a handful per job; every relayed call
 * costs Sidequest a simulation and possibly gas, so a flood is refused before anything is read.
 */
export const escrowLimit: Limit = { limit: 30, windowSeconds: 60 }

// `WalletSignature` and `Bytes32` admit only hex, so the fallback never applies.
const hexOf = (value: string): Hex => (isHex(value) ? value : '0x')

/**
 * The `escrow` group. Nothing ambient is read here, so any origin may call it (see `SidequestApi`). A money call's
 * authority is the wallet signature it carries, which the contract verifies; a ruling's is its NIP-98 authorization by
 * the arbitration key. Every request is counted against the client's address first.
 */
export const escrowHandlers = HttpApiBuilder.group(SidequestApi, 'escrow', (handlers) =>
  Effect.gen(function* () {
    const escrow = yield* escrowSteps
    const limiter = yield* RateLimiter
    const jobs = yield* Jobs
    const kept = yield* keptTerms
    const settings = yield* EscrowSettings
    const limited = <A, E, R>(request: HttpServerRequest, effect: Effect.Effect<A, E, R>) =>
      Effect.andThen(limiter.take(`escrow:${clientAddress(request)}`, escrowLimit), effect)
    return handlers
      .handle('quote', ({ params, query, request }) =>
        limited(request, escrow.quote(params.id, params.proposal, query.payer)),
      )
      .handle('fund', ({ params, payload, request }) =>
        limited(request, escrow.fund(params.id, params.proposal, payload.payer, hexOf(payload.signature))),
      )
      .handle('deliveryToSign', ({ params, query, request }) =>
        limited(request, escrow.deliveryToSign(params.id, hexOf(query.deliveryHash))),
      )
      .handle('deliver', ({ params, payload, request }) =>
        limited(request, escrow.deliver(params.id, hexOf(payload.deliveryHash), hexOf(payload.signature))),
      )
      .handle('deliveryDelegationToSign', ({ params, query, request }) =>
        limited(request, escrow.delegationToSign(params.id, getAddress(query.delegate.toLowerCase()), query.expiry)),
      )
      .handle('deliverDelegated', ({ params, payload, request }) =>
        limited(
          request,
          escrow.deliverDelegated(params.id, {
            deliveryHash: hexOf(payload.deliveryHash),
            delegate: getAddress(payload.delegate.toLowerCase()),
            expiry: payload.expiry,
            signature: hexOf(payload.signature),
            delegation: hexOf(payload.delegation),
          }),
        ),
      )
      .handle('approvalToSign', ({ params, request }) => limited(request, escrow.verdictToSign(params.id, 'approve')))
      .handle('approve', ({ params, payload, request }) =>
        limited(request, escrow.verdict(params.id, 'approve', hexOf(payload.signature))),
      )
      .handle('rejectionToSign', ({ params, request }) => limited(request, escrow.verdictToSign(params.id, 'reject')))
      .handle('reject', ({ params, payload, request }) =>
        limited(request, escrow.verdict(params.id, 'reject', hexOf(payload.signature))),
      )
      .handle('rule', ({ params, payload, request }) =>
        limited(
          request,
          Effect.andThen(requireArbitrationKey(request, settings), escrow.rule(params.id, payload.workerShareBps)),
        ),
      )
      .handle('payment', ({ params, request }) => limited(request, escrow.status(params.id)))
      .handle('terms', ({ params }) =>
        Effect.gen(function* () {
          const view = yield* jobs.job(params.id)
          const preferred = Option.getOrNull(Option.flatMapNullishOr(view, (job) => job.funding?.proposal))
          const terms = yield* kept.terms(params.id, preferred)
          if (Option.isNone(terms)) return yield* new NotIndexed()
          // Signed events never change, but a reorganisation could unfund the job: cache briefly.
          yield* publicFor(60)
          return terms.value
        }),
      )
  }),
)
