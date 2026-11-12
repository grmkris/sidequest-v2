import { Schema } from 'effect'
import { Amount } from './Amount.ts'
import { AssetId } from './AssetRef.ts'
import { Bytes32 } from './Bytes32.ts'
import { NetworkRef } from './NetworkRef.ts'
import { WalletAddress } from './SessionApi.ts'
import { TypedData } from './TypedData.ts'
import { UnixSeconds } from './UnixSeconds.ts'

/**
 * What the buyer is asked to sign to fund a job, and every parameter the one signature binds, for the website to
 * show before the wallet does: the parties, the amount, the deadlines and windows, the arbitrator and the fee. The
 * signature is an ERC-3009 `ReceiveWithAuthorization` whose nonce is the payment's hash without the payer, so it
 * commits to all of them.
 */
export const FundingRequest = Schema.Struct({
  request: Schema.String,
  state: Schema.Literals(['begun', 'submitted']),
  paymentHash: Bytes32,
  network: NetworkRef,
  asset: AssetId,
  amount: Amount,
  payer: WalletAddress,
  receiver: WalletAddress,
  operator: WalletAddress,
  escrow: WalletAddress,
  arbitrator: WalletAddress,
  feeReceiver: WalletAddress,
  feeBps: Schema.Int,
  deliveryDeadline: UnixSeconds,
  reviewWindowSeconds: Schema.Int,
  disputeWindowSeconds: Schema.Int,
  arbitrationWindowSeconds: Schema.Int,
  preApprovalExpiry: UnixSeconds,
  authorizationExpiry: UnixSeconds,
  typedData: TypedData,
})
export type FundingRequest = typeof FundingRequest.Type
