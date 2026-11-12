import { type Agreement, Amount, type FundingRequest } from '@sidequest/protocol'
import { Effect, Layer, Option } from 'effect'
import { getAddress, type Hex, isAddressEqual } from 'viem'
import { ChainRpc, rpcCall } from './ChainRpc.ts'
import type { Expected } from './Expected.ts'
import { type Payment, paymentOf } from './Payment.ts'
import { AlreadySubmitted, NotBegun, ParametersChanged, PaymentAdapter, type PaymentRequest } from './PaymentAdapter.ts'
import { type PaymentRecord, PaymentRequests } from './PaymentRequests.ts'
import { Relayer } from './Relayer.ts'
import type { SettlementChain } from './SettlementChain.ts'
import { fundingTypedData, toProtocolTypedData } from './TypedData.ts'

/** Everything the buyer is shown and signs for a payment. */
export const fundingRequestOf = (
  record: PaymentRecord,
  agreement: Agreement,
  payment: Payment,
  chain: SettlementChain,
): FundingRequest => ({
  request: record.id,
  state: record.state === 'submitted' ? 'submitted' : 'begun',
  paymentHash: payment.hash,
  network: chain.asset.network,
  asset: chain.asset.id,
  amount: Amount.make(String(payment.info.maxAmount)),
  payer: payment.info.payer,
  receiver: payment.info.receiver,
  operator: chain.operator,
  escrow: chain.escrow,
  arbitrator: payment.params.arbitrator,
  feeReceiver: chain.feeReceiver,
  feeBps: chain.feeBps,
  deliveryDeadline: agreement.terms.deliveryDeadline,
  reviewWindowSeconds: agreement.terms.reviewWindowSeconds,
  disputeWindowSeconds: agreement.terms.disputeWindowSeconds,
  arbitrationWindowSeconds: agreement.terms.arbitrationWindowSeconds,
  preApprovalExpiry: payment.info.preApprovalExpiry,
  authorizationExpiry: payment.info.authorizationExpiry,
  typedData: toProtocolTypedData(fundingTypedData(payment, chain)),
})

/** The payment a stored request stands for, rebuilt from the agreement: what the chain reader must find. */
export const expectedOf = (record: PaymentRecord, agreement: Agreement, chain: SettlementChain) =>
  paymentOf(agreement, { payer: getAddress(record.payer), receiver: getAddress(record.receiver) }, chain).pipe(
    Effect.map((payment): Expected => ({ agreement, payment, chain, fromBlock: BigInt(record.fromBlock) })),
  )

const sameParties = (record: PaymentRecord, request: PaymentRequest) =>
  isAddressEqual(getAddress(record.payer), request.payer) &&
  isAddressEqual(getAddress(record.receiver), request.receiver)

/**
 * The escrow rail: a payment request is the exact `AuthCaptureEscrow` payment for the agreement and its parties. The
 * buyer signs its ERC-3009 authorization; the adapter relays `SidequestOperator.fund` with it. It holds no key of the
 * buyer's, and the relayer can change nothing the signature covers.
 */
export const EscrowAdapter = (chain: SettlementChain) =>
  Layer.effect(
    PaymentAdapter,
    Effect.gen(function* () {
      const rpc = yield* ChainRpc
      const requests = yield* PaymentRequests
      const relayer = yield* Relayer

      const begin = Effect.fn('Sidequest.Settlement.begin')(function* (request: PaymentRequest) {
        const payment = yield* paymentOf(request.agreement, request, chain)
        const existing = yield* requests.find(request.id)
        const head = Option.isSome(existing)
          ? BigInt(existing.value.fromBlock)
          : yield* rpcCall('eth_blockNumber', () => rpc.getBlockNumber({ cacheTime: 0 }))
        const record = yield* requests.open({
          id: request.id,
          job: request.agreement.job,
          payer: payment.info.payer,
          receiver: payment.info.receiver,
          paymentHash: payment.hash,
          fromBlock: String(head),
          state: 'begun',
          transactionHash: null,
        })
        if (!sameParties(record, request))
          return yield* record.state === 'submitted'
            ? new AlreadySubmitted({ request: request.id })
            : new ParametersChanged({ request: request.id })
        return fundingRequestOf(record, request.agreement, payment, chain)
      })

      const submit = Effect.fn('Sidequest.Settlement.submit')(function* (
        id: string,
        agreement: Agreement,
        authorization: Hex,
      ) {
        const record = yield* requests.find(id)
        if (Option.isNone(record) || record.value.state === 'cancelled') return yield* new NotBegun({ request: id })
        const { payment } = yield* expectedOf(record.value, agreement, chain)
        const relayed = yield* relayer.relay(`fund:${payment.hash}`, {
          function: 'fund',
          info: payment.info,
          params: payment.params,
          authorization,
        })
        yield* requests.submitted(id, relayed.transactionHash)
        return relayed
      })

      const cancel = Effect.fn('Sidequest.Settlement.cancel')(function* (id: string) {
        const record = yield* requests.find(id)
        if (Option.isSome(record) && record.value.state === 'submitted')
          return yield* new AlreadySubmitted({ request: id })
        yield* requests.cancelled(id)
      })

      return PaymentAdapter.of({ begin, submit, lookup: requests.find, cancel })
    }),
  )
