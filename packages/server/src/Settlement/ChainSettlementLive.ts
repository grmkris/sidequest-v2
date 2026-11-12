import { type CallResult, Settlement } from '@sidequest/domain/Job/Settlement.external'
import type { Agreement } from '@sidequest/protocol'
import type { DeadlineFunction } from '@sidequest/settlement/OperatorCall'
import { Effect, Option } from 'effect'
import { Escrow, type EscrowService } from './Escrow.ts'

const notSent = (reason: string): CallResult => ({ _tag: 'NotSent', reason })

/** What the chain reader verified, or null when the chain or a settlement store cannot be read just now. */
const observe = (service: EscrowService, agreement: Agreement) =>
  service
    .status(agreement)
    .pipe(
      Effect.catch((failure) =>
        Effect.logWarning('Sidequest.Settlement.unreadable', failure).pipe(
          Effect.annotateLogs({ job: agreement.job }),
          Effect.as(null),
        ),
      ),
    )

/** Relays one attempt of a deadline call as its own transaction, and says whether it went out and why not. */
const trigger = (service: EscrowService, agreement: Agreement, call: DeadlineFunction, attempt: number) =>
  Effect.gen(function* () {
    const expected = yield* service.expected(agreement)
    if (Option.isNone(expected)) return notSent('NoPaymentRequest')
    const { payment } = expected.value
    const relayed = yield* service.relay(`${call}:${payment.hash}:${attempt}`, { function: call, info: payment.info })
    const sent: CallResult = { _tag: 'Sent', transactionHash: relayed.transactionHash }
    return sent
  }).pipe(
    Effect.catchTags({
      CallReverted: ({ reason }) => Effect.succeed(notSent(reason)),
      IntentConflict: () => Effect.succeed(notSent('IntentConflict')),
      UnpayableAgreement: () => Effect.succeed(notSent('UnpayableAgreement')),
      ChainUnavailable: () => Effect.succeed(notSent('ChainUnavailable')),
      SettlementStoreError: () => Effect.succeed(notSent('SettlementStoreError')),
    }),
  )

/**
 * The domain's `Settlement` over the escrow: `observe` is the chain reader on the job's payment, `trigger` relays a
 * deadline function from the relayer key. Without a configured escrow there is nothing to read and nothing to send.
 */
export const ChainSettlementLive = Settlement.toLayer(
  Effect.gen(function* () {
    const escrow = yield* Escrow
    return {
      observe: ({ agreement }) =>
        Option.match(escrow, {
          onNone: () => Effect.succeed(null),
          onSome: (service) => observe(service, agreement),
        }),
      trigger: ({ agreement, call, attempt }) =>
        Option.match(escrow, {
          onNone: () => Effect.succeed(notSent('NotConfigured')),
          onSome: (service) => trigger(service, agreement, call, attempt),
        }),
    }
  }),
)
