import type { PublicKey } from '@sidequest/nostr'
import { deliveryDigestOfTypedData, signDigestAsEvm } from '@sidequest/nostr/vocabulary'
import type { TypedData } from '@sidequest/protocol'
import { nowSeconds } from '@sidequest/serving/Authorize'
import { Effect, Option } from 'effect'
import { Core, CoreRefused } from '../Core/Core.ts'
import { AgentKeys } from '../Keys/AgentKeys.ts'
import { Refused } from '../Mcp/Tools.ts'
import { Delegations, type HeldDelegation } from './Delegations.ts'

// Recording a delivery on chain as the agent's key, under its operator wallet's delegation for the job: the agent's
// key signs the operator's `Delivery` digest as the delegate, and the core relays it with the wallet's
// `DeliveryDelegate` signature to `SidequestOperator.deliverDelegated`, which checks both. The key is opened only for
// that one signature, and it signs nothing but a `SidequestOperator` `Delivery`.

/** The gateway's store not answering, as a tool's refusal. */
const storeUnavailable = () => new Refused({ reason: 'CoreUnavailable', detail: 'The gateway’s store.' })

/** The delegation the gateway holds for the agent and job, if it is still ahead of the clock. */
export const heldDelegation = Effect.fnUntraced(function* (agent: PublicKey, job: string) {
  const delegations = yield* Delegations
  const held = yield* delegations
    .find(agent, job)
    .pipe(Effect.catchTag('Unavailable', () => Effect.fail(storeUnavailable())))
  const now = yield* nowSeconds
  return Option.filter(held, ({ expiry }) => expiry > now)
})

/**
 * Signs the delivery the core served (`typedData`, a `Delivery` of the job's payment) with the agent's key and has the
 * core relay it under `held`. Fails with the core's refusal when the chain or the core would not take it.
 */
export const relayDelegatedDelivery = Effect.fnUntraced(function* (
  agent: PublicKey,
  job: string,
  delivery: { readonly deliveryHash: string; readonly typedData: TypedData },
  delegate: string,
  held: HeldDelegation,
) {
  const keys = yield* AgentKeys
  const core = yield* Core
  const digest = deliveryDigestOfTypedData(delivery.typedData)
  if (Option.isNone(digest))
    return yield* new CoreRefused({ refusal: 'IndexSettlementRefused', detail: 'The core served no Delivery to sign.' })
  const signature = yield* keys
    .withKey(agent, (key) => Effect.succeed(signDigestAsEvm(digest.value, key)))
    .pipe(
      Effect.catchTags({
        KeyUnsealable: () => Effect.fail(new Refused({ reason: 'KeyUnavailable' })),
        Unavailable: () => Effect.fail(storeUnavailable()),
      }),
    )
  // The digest is 32 bytes, so the key always signs it.
  if (Option.isNone(signature)) return yield* new Refused({ reason: 'KeyUnavailable' })
  return yield* core.deliverDelegated(job, {
    deliveryHash: delivery.deliveryHash,
    delegate,
    expiry: held.expiry,
    signature: signature.value,
    delegation: held.signature,
  })
})
