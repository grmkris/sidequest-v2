import { type Address, encodeFunctionData, type Hex } from 'viem'
import { sidequestOperatorAbi } from './abi/SidequestOperator.ts'
import type { JobParams, PaymentInfo } from './Payment.ts'

/** A deadline function of the operator that anyone may call once its time has come. */
export type DeadlineFunction = 'settleAfterReview' | 'settleUnruled' | 'refundUndelivered'

/**
 * One call of a `SidequestOperator` function, the only contract the relayer sends to. The signed ones carry the
 * named party's signature, which Sidequest only relays; the deadline ones need none.
 */
export type OperatorCall =
  | {
      readonly function: 'fund'
      readonly info: PaymentInfo
      readonly params: JobParams
      readonly authorization: Hex
    }
  | { readonly function: 'deliver'; readonly info: PaymentInfo; readonly deliveryHash: Hex; readonly signature: Hex }
  | {
      readonly function: 'deliverDelegated'
      readonly info: PaymentInfo
      readonly deliveryHash: Hex
      /** The key the worker delegated the delivery to, and the delegation's expiry, as the worker signed them. */
      readonly delegate: Address
      readonly expiry: number
      /** The delegate's `Delivery` signature. */
      readonly signature: Hex
      /** The worker's `DeliveryDelegate` signature. */
      readonly delegation: Hex
    }
  | { readonly function: 'approve' | 'reject'; readonly info: PaymentInfo; readonly signature: Hex }
  | {
      readonly function: 'rule'
      readonly info: PaymentInfo
      readonly workerShareBps: number
      readonly signature: Hex
    }
  | { readonly function: DeadlineFunction; readonly info: PaymentInfo }

/** The calldata of an operator call. */
export const operatorCalldata = (call: OperatorCall): Hex => {
  switch (call.function) {
    case 'fund':
      return encodeFunctionData({
        abi: sidequestOperatorAbi,
        functionName: 'fund',
        args: [call.info, call.params, call.authorization],
      })
    case 'deliver':
      return encodeFunctionData({
        abi: sidequestOperatorAbi,
        functionName: 'deliver',
        args: [call.info, call.deliveryHash, call.signature],
      })
    case 'deliverDelegated':
      return encodeFunctionData({
        abi: sidequestOperatorAbi,
        functionName: 'deliverDelegated',
        args: [call.info, call.deliveryHash, call.delegate, call.expiry, call.signature, call.delegation],
      })
    case 'approve':
    case 'reject':
      return encodeFunctionData({
        abi: sidequestOperatorAbi,
        functionName: call.function,
        args: [call.info, call.signature],
      })
    case 'rule':
      return encodeFunctionData({
        abi: sidequestOperatorAbi,
        functionName: 'rule',
        args: [call.info, call.workerShareBps, call.signature],
      })
    case 'settleAfterReview':
    case 'settleUnruled':
    case 'refundUndelivered':
      return encodeFunctionData({ abi: sidequestOperatorAbi, functionName: call.function, args: [call.info] })
  }
}
