import { Context } from 'effect'

/**
 * How often the settlement sagas look at the chain, in milliseconds. While something is in flight (a relayed
 * signature, a deadline call) they look again after `pollMillis`, doubling each time up to `maxPollMillis`, until the
 * chain shows the step. With nothing in flight, `SettleJob` sleeps until the stage's deadline, looking at least every
 * `idleMillis`: a step taken on chain directly, or one whose confirmation gave up, is recorded within that, and so is
 * the deadline it moves. Tests shorten them.
 */
export const SettlementTiming = Context.Reference('Sidequest/SettlementTiming', {
  defaultValue: () => ({ pollMillis: 15_000, maxPollMillis: 60 * 60_000, idleMillis: 60 * 60_000 }),
})
