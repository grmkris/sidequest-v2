import { Clock, Context, Data, Effect, Exit, Layer, Option, Redacted, Schema } from 'effect'
import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  type Hex,
  isHex,
  keccak256,
  type PrivateKeyAccount,
  type PublicClient,
  RpcError,
  RpcRequestError,
  toFunctionSelector,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sidequestOperatorAbi } from './abi/SidequestOperator.ts'
import { ChainRpc, ChainUnavailable, rpcCall } from './ChainRpc.ts'
import { type OperatorCall, operatorCalldata } from './OperatorCall.ts'
import type { SettlementStoreError } from './ReaderCursors.ts'
import { type RelayIntent, RelayerIntents, type RelayTransaction } from './RelayerIntents.ts'
import type { SettlementChain } from './SettlementChain.ts'

/** The id names another call already: one id is one action on one job, and its call never changes. */
export class IntentConflict extends Schema.TaggedError<IntentConflict>()('IntentConflict', { id: Schema.String }) {}

/**
 * The chain refuses the call: it reverts in simulation (so it would fail on chain too), it reverted on chain
 * (`RevertedOnChain`), or its nonce is being released because it could not be mined (`Released: <why>`).
 */
export class CallReverted extends Schema.TaggedError<CallReverted>()('CallReverted', {
  function: Schema.String,
  reason: Schema.String,
}) {}

/** A relayed transaction: the intent it belongs to and its hash. */
export interface Relayed {
  readonly id: string
  readonly transactionHash: Hex
}

export type RelayError = IntentConflict | CallReverted | ChainUnavailable | SettlementStoreError

/**
 * When the relayer stops waiting and repairs an intent. A transaction neither mined nor replaced after
 * `stuckAfterMillis` is stuck, and so is one the node refused. A stuck call is signed again at the same nonce with fees
 * at least `bumpPercent` higher, at most `maxReplacements` times; after that, or as soon as the call reverts in
 * simulation, the nonce is released. A release is replaced the same way, at most `maxReplacements` times.
 */
export interface RepairPolicy {
  readonly stuckAfterMillis: number
  readonly maxReplacements: number
  readonly bumpPercent: number
}

export const defaultRepairPolicy: RepairPolicy = { stuckAfterMillis: 120_000, maxReplacements: 3, bumpPercent: 25 }

/** Gas for a transfer, which is all a release is. */
const transferGas = 21_000n
/** Looks one relay takes at one intent before it answers with where things stand. */
const maxSteps = 8

/** Why a call reverted, if the error says it did; otherwise the chain was out of reach. */
const revertReason = (cause: unknown) => {
  if (!(cause instanceof BaseError)) return undefined
  const reverted = cause.walk((error) => error instanceof ContractFunctionRevertedError)
  if (reverted instanceof ContractFunctionRevertedError) return reverted.data?.errorName ?? reverted.shortMessage
  return /revert/i.test(cause.message) ? cause.shortMessage : undefined
}

/** What the node answered instead of a result: a revert, a refusal, or a transport failure; read by its cause. */
class NodeAnswer extends Data.TaggedError('NodeAnswer')<{ readonly cause: unknown }> {}

/** JSON-RPC codes that mean the node had a problem of its own, not with the transaction: ask again later. */
const transientCodes = new Set([-1, -32002, -32005, -32603])

/**
 * What the node said when it refused a transaction outright (an underpriced fee, a nonce it will not take, a policy),
 * or undefined when the transport failed and nobody knows whether the transaction arrived.
 */
const refusalOf = (cause: unknown) => {
  if (!(cause instanceof BaseError)) return undefined
  const answered = cause.walk(
    (error) =>
      (error instanceof RpcError || error instanceof RpcRequestError) &&
      typeof error.code === 'number' &&
      !transientCodes.has(error.code),
  )
  return answered instanceof BaseError ? answered.details || answered.shortMessage : undefined
}

/** How nodes (geth, reth, Anvil) say they hold a transaction already. */
const alreadyKnown = /already known|known transaction|already imported|already exists/i

const functionNames = new Map<string, string>(
  sidequestOperatorAbi.flatMap((item) =>
    item.type === 'function' ? [[toFunctionSelector(item), item.name] as const] : [],
  ),
)
/** The operator function an intent's calldata calls, for errors. */
const functionOf = (intent: RelayIntent) => functionNames.get(intent.data.slice(0, 10)) ?? 'unknown'

const hexOf = (value: string): Hex => (isHex(value) ? value : '0x')

const refusedCall = (intent: RelayIntent, reason: string) =>
  Effect.fail(new CallReverted({ function: functionOf(intent), reason }))

/** What a simulation found: the gas the call needs, or why it would revert. */
type Simulation = { readonly runs: true; readonly gas: bigint } | { readonly runs: false; readonly reason: string }

/** What the chain shows for an open intent, and so what the relayer does next. */
type Look = Data.TaggedEnum<{
  /** The nonce is used: by one of the intent's transactions, or (`transaction` undefined) by one it never signed. */
  Used: { readonly transaction: RelayTransaction | undefined; readonly reverted: boolean }
  /** Nothing is signed at the nonce yet: the relay that reserved it stopped before signing. */
  Unsigned: {}
  /** The latest transaction is pending. */
  Waiting: { readonly transaction: RelayTransaction }
  /** The node does not know the latest transaction (never sent, or dropped), but it is too soon to call it stuck. */
  Lost: { readonly transaction: RelayTransaction }
  /** The latest transaction was refused, or was not mined in time: replace it. */
  Stuck: { readonly transaction: RelayTransaction; readonly why: string }
}>
const Look = Data.taggedEnum<Look>()

/** Where one relay stands with an intent between two looks. */
type Progress =
  | { readonly done: false; readonly intent: RelayIntent }
  | { readonly done: true; readonly relayed: Relayed }

/** What every step needs: the chain, the store, the key, the chain's contracts and the repair policy. */
interface Wiring {
  readonly rpc: PublicClient
  readonly intents: RelayerIntents['Service']
  readonly account: PrivateKeyAccount
  readonly chain: SettlementChain
  readonly policy: RepairPolicy
}

const nonceAt = (w: Wiring, blockTag: 'latest' | 'pending') =>
  rpcCall('eth_getTransactionCount', () => w.rpc.getTransactionCount({ address: w.account.address, blockTag }))

const simulate = (w: Wiring, data: string) =>
  Effect.tryPromise({
    try: () => w.rpc.estimateGas({ account: w.account.address, to: w.chain.operator, data: hexOf(data) }),
    catch: (cause) => new NodeAnswer({ cause }),
  }).pipe(
    Effect.map((gas): Simulation => ({ runs: true, gas: (gas * 6n) / 5n })),
    Effect.catch(({ cause }) => {
      const reason = revertReason(cause)
      return reason === undefined
        ? Effect.fail(new ChainUnavailable({ operation: 'eth_estimateGas' }))
        : Effect.succeed<Simulation>({ runs: false, reason })
    }),
  )

/** The estimated fee, or the last one at the nonce raised by the bump, whichever is higher. */
const atLeast = (policy: RepairPolicy, estimated: bigint, last: string | undefined) => {
  if (last === undefined) return estimated
  const bumped = (BigInt(last) * BigInt(100 + policy.bumpPercent) + 99n) / 100n
  return estimated > bumped ? estimated : bumped
}

const feesAbove = Effect.fnUntraced(function* (w: Wiring, previous: RelayTransaction | undefined) {
  const estimate = yield* rpcCall('eth_feeHistory', () => w.rpc.estimateFeesPerGas())
  const maxPriorityFeePerGas = atLeast(w.policy, estimate.maxPriorityFeePerGas, previous?.maxPriorityFeePerGas)
  const maxFeePerGas = atLeast(w.policy, estimate.maxFeePerGas, previous?.maxFeePerGas)
  return {
    maxPriorityFeePerGas,
    maxFeePerGas: maxFeePerGas > maxPriorityFeePerGas ? maxFeePerGas : maxPriorityFeePerGas,
  }
})

/** What to sign: the intent's call with its gas, or a release and why. */
type Signing = { readonly gas: bigint; readonly reason: string | null } | { readonly release: string }

/**
 * Signs the intent's call, or a release, at its nonce, and records it, unless another relay recorded a transaction
 * there first; either way it answers the intent as stored, whose latest transaction is the one to send.
 */
const sign = Effect.fnUntraced(function* (w: Wiring, intent: RelayIntent, signing: Signing) {
  const fees = yield* feesAbove(w, intent.transactions.at(-1))
  const call = 'gas' in signing
  const raw = yield* rpcCall('sign', () =>
    w.account.signTransaction({
      type: 'eip1559',
      chainId: w.chain.chainId,
      nonce: intent.nonce,
      ...(call
        ? { to: w.chain.operator, data: hexOf(intent.data), gas: signing.gas }
        : { to: w.account.address, value: 0n, gas: transferGas }),
      ...fees,
    }),
  )
  return yield* w.intents.record(intent.id, intent.nonce, {
    hash: keccak256(raw),
    sequence: intent.transactions.length,
    kind: call ? 'call' : 'release',
    raw,
    maxFeePerGas: String(fees.maxFeePerGas),
    maxPriorityFeePerGas: String(fees.maxPriorityFeePerGas),
    signedAt: yield* Clock.currentTimeMillis,
    reason: call ? signing.reason : signing.release,
    refused: null,
  })
})

/** Sends a recorded transaction. A refusal is recorded on it; a transport failure leaves it to the next look. */
const broadcast = (w: Wiring, transaction: RelayTransaction) =>
  Effect.tryPromise({
    try: () => w.rpc.sendRawTransaction({ serializedTransaction: hexOf(transaction.raw) }),
    catch: (cause) => new NodeAnswer({ cause }),
  }).pipe(
    Effect.asVoid,
    Effect.catch(({ cause }): Effect.Effect<void, ChainUnavailable | SettlementStoreError> => {
      const refusal = refusalOf(cause)
      if (refusal === undefined) return Effect.fail(new ChainUnavailable({ operation: 'eth_sendRawTransaction' }))
      // Another relay sent the same bytes first: the node holds the transaction, which is all that was asked.
      if (alreadyKnown.test(refusal)) return Effect.void
      return Effect.andThen(
        Effect.logWarning('Sidequest.Settlement.transactionRefused').pipe(
          Effect.annotateLogs({ alert: 'settlement-relayer', transaction: transaction.hash, refusal }),
        ),
        w.intents.refused(transaction.hash, refusal),
      )
    }),
  )

/** The intent's transaction that used its nonce, if the chain has a receipt for one. */
const usedBy = Effect.fnUntraced(function* (w: Wiring, intent: RelayIntent) {
  for (const transaction of intent.transactions) {
    const receipt = yield* rpcCall('eth_getTransactionReceipt', () =>
      w.rpc.getTransactionReceipt({ hash: hexOf(transaction.hash) }),
    ).pipe(Effect.option)
    if (Option.isSome(receipt))
      return Option.some(Look.Used({ transaction, reverted: receipt.value.status === 'reverted' }))
  }
  return Option.none<Look>()
})

/** A used nonce: whose it was. With no receipt for any of ours, a lagging node and a key used elsewhere look alike. */
const lookUsed = Effect.fnUntraced(function* (w: Wiring, intent: RelayIntent, overdue: boolean) {
  const found = yield* usedBy(w, intent)
  if (Option.isSome(found)) return found.value
  if (intent.transactions.length > 0 && !overdue)
    return yield* new ChainUnavailable({ operation: 'eth_getTransactionReceipt' })
  return Look.Used({ transaction: undefined, reverted: false })
})

/** An unused nonce: what became of its latest transaction. */
const lookUnused = Effect.fnUntraced(function* (w: Wiring, latest: RelayTransaction | undefined, overdue: boolean) {
  if (latest === undefined) return Look.Unsigned()
  if (latest.refused !== null) return Look.Stuck({ transaction: latest, why: `Refused: ${latest.refused}` })
  if (overdue) return Look.Stuck({ transaction: latest, why: 'NotMined' })
  const pending = yield* rpcCall('eth_getTransactionByHash', () =>
    w.rpc.getTransaction({ hash: hexOf(latest.hash) }),
  ).pipe(Effect.option)
  return Option.isSome(pending) ? Look.Waiting({ transaction: latest }) : Look.Lost({ transaction: latest })
})

/** Where an open intent stands on chain. */
const look = Effect.fnUntraced(function* (w: Wiring, intent: RelayIntent) {
  const used = yield* nonceAt(w, 'latest')
  const now = yield* Clock.currentTimeMillis
  const latest = intent.transactions.at(-1)
  const overdue = latest !== undefined && now - latest.signedAt >= w.policy.stuckAfterMillis
  return intent.nonce < used ? yield* lookUsed(w, intent, overdue) : yield* lookUnused(w, latest, overdue)
})

/** The answer for a closed intent: its mined call, or why it has none. */
const closed = (intent: RelayIntent): Effect.Effect<Relayed, CallReverted> => {
  const mined = intent.state === 'mined' && intent.reason === null && intent.outcome !== null
  if (mined && isHex(intent.outcome)) return Effect.succeed<Relayed>({ id: intent.id, transactionHash: intent.outcome })
  const reason = intent.reason ?? 'unknown'
  return refusedCall(intent, intent.state === 'released' ? `Released: ${reason}` : reason)
}

/** The answer while an intent's latest transaction is out: the call's hash, or the release that replaced it. */
const answer = (
  intent: RelayIntent,
  transaction: RelayTransaction | undefined,
): Effect.Effect<Relayed, CallReverted | ChainUnavailable> => {
  if (intent.state !== 'open') return closed(intent)
  if (transaction === undefined) return Effect.fail(new ChainUnavailable({ operation: 'relay' }))
  if (transaction.kind === 'release') return refusedCall(intent, `Released: ${transaction.reason ?? 'unknown'}`)
  return Effect.succeed<Relayed>({ id: intent.id, transactionHash: hexOf(transaction.hash) })
}

/** Signs what replaces a stuck transaction: the call with higher fees while it still runs, else a release. */
const replace = Effect.fnUntraced(function* (w: Wiring, intent: RelayIntent, stuck: RelayTransaction, why: string) {
  const count = (kind: RelayTransaction['kind']) => intent.transactions.filter((sent) => sent.kind === kind).length
  if (stuck.kind === 'release')
    return count('release') > w.policy.maxReplacements
      ? intent
      : yield* sign(w, intent, { release: stuck.reason ?? why })
  const simulation = yield* simulate(w, intent.data)
  if (simulation.runs && count('call') <= w.policy.maxReplacements)
    return yield* sign(w, intent, { gas: simulation.gas, reason: why })
  const reason = simulation.runs ? why : `Reverts: ${simulation.reason}`
  yield* Effect.logWarning('Sidequest.Settlement.nonceReleased').pipe(
    Effect.annotateLogs({ alert: 'settlement-relayer', intent: intent.id, nonce: intent.nonce, reason }),
  )
  return yield* sign(w, intent, { release: reason })
})

const reread = (w: Wiring, intent: RelayIntent) =>
  Effect.map(w.intents.find(intent.id), (found) => Option.getOrElse(found, () => intent))

/** Closes an intent whose nonce is used, as mined by its call or released. */
const close = (w: Wiring, intent: RelayIntent, transaction: RelayTransaction | undefined, reverted: boolean) => {
  const mined = transaction?.kind === 'call'
  const failed = reverted ? 'RevertedOnChain' : null
  return w.intents.close(intent.id, intent.nonce, {
    state: mined ? 'mined' : 'released',
    outcome: transaction?.hash ?? null,
    reason: mined ? failed : (transaction?.reason ?? 'NonceUsedElsewhere'),
  })
}

/** The first transaction of an intent: its call while it runs, else a release of the nonce it reserved. */
const signFirst = Effect.fnUntraced(function* (w: Wiring, intent: RelayIntent, gas: Option.Option<bigint>) {
  const simulation: Simulation = Option.isSome(gas) ? { runs: true, gas: gas.value } : yield* simulate(w, intent.data)
  return simulation.runs
    ? yield* sign(w, intent, { gas: simulation.gas, reason: null })
    : yield* sign(w, intent, { release: `Reverts: ${simulation.reason}` })
})

/** The relay is over: it answers with the call's transaction, or fails. */
const finish = <E>(relayed: Effect.Effect<Relayed, E>) =>
  Effect.map(relayed, (value): Progress => ({ done: true, relayed: value }))

/**
 * One step with an open intent, from what the chain shows: close it, sign and send its first transaction, send it
 * again, replace it, or answer. `gas` is the reserving relay's simulation; `sent` what this relay sent already.
 */
const step = (w: Wiring, intent: RelayIntent, seen: Look, gas: Option.Option<bigint>, sent: Set<string>) => {
  const send = Effect.fnUntraced(function* (signed: RelayIntent) {
    const latest = signed.transactions.at(-1)
    if (latest !== undefined && !sent.has(latest.hash)) {
      sent.add(latest.hash)
      yield* broadcast(w, latest)
    }
    const next: Progress = { done: false, intent: yield* reread(w, signed) }
    return next
  })
  const next = (stored: RelayIntent): Effect.Effect<Progress, SettlementStoreError> =>
    Effect.map(reread(w, stored), (latest): Progress => ({ done: false, intent: latest }))
  return Look.$match(seen, {
    // The nonce is used: there is nothing left to send. Sending a mined transaction again could only be refused, and
    // the refusal would be recorded on it and alerted as if it were news.
    Used: ({ transaction, reverted }) => Effect.andThen(close(w, intent, transaction, reverted), next(intent)),
    Unsigned: () => Effect.flatMap(signFirst(w, intent, gas), send),
    Waiting: ({ transaction }) => finish(answer(intent, transaction)),
    // Sent by this relay already and still unknown: the node has it or will refuse it; the next look will tell.
    Lost: ({ transaction }) => (sent.has(transaction.hash) ? finish(answer(intent, transaction)) : send(intent)),
    Stuck: ({ transaction, why }) =>
      Effect.flatMap(replace(w, intent, transaction, why), (replaced) =>
        replaced.transactions.length === intent.transactions.length && sent.has(transaction.hash)
          ? Effect.fail(new ChainUnavailable({ operation: 'eth_sendRawTransaction' }))
          : send(replaced),
      ),
  })
}

/**
 * Takes an open intent as far as it goes now: signs, sends, replaces and closes, then answers with the call's
 * transaction once one is pending or mined.
 */
const drive = Effect.fnUntraced(function* (w: Wiring, start: RelayIntent, gas: Option.Option<bigint>) {
  const sent = new Set<string>()
  let progress: Progress = { done: false, intent: start }
  for (let looked = 0; looked < maxSteps && !progress.done && progress.intent.state === 'open'; looked += 1)
    progress = yield* step(w, progress.intent, yield* look(w, progress.intent), gas, sent)
  if (progress.done) return progress.relayed
  return yield* answer(progress.intent, progress.intent.transactions.at(-1))
})

/** A released intent whose call runs again takes a fresh nonce: the mined release proved the old one dead. */
const retry = Effect.fnUntraced(function* (w: Wiring, intent: RelayIntent) {
  const simulation = yield* simulate(w, intent.data)
  if (!simulation.runs) return yield* refusedCall(intent, simulation.reason)
  const reopened = yield* w.intents.reopen(intent.id, yield* nonceAt(w, 'pending'))
  return yield* drive(w, reopened, Option.some(simulation.gas))
})

/** Every open intent gets a look; the first that could not be taken further is reported once all have had one. */
const repairAll = (w: Wiring) =>
  Effect.gen(function* () {
    const open = yield* w.intents.open(w.account.address)
    const outcomes = yield* Effect.forEach(open, (intent) =>
      drive(w, intent, Option.none()).pipe(
        Effect.asVoid,
        Effect.catchTags({ CallReverted: () => Effect.void }),
        Effect.exit,
      ),
    )
    const failure = outcomes.find(Exit.isFailure)
    if (failure !== undefined) return yield* failure
  }).pipe(Effect.withSpan('Sidequest.Settlement.repair'))

/** Relays an existing intent: the same call again, or a conflict; a released one is retried at a fresh nonce. */
const resume = (w: Wiring, existing: RelayIntent, data: string) => {
  if (existing.data !== data) return Effect.fail(new IntentConflict({ id: existing.id }))
  return existing.state === 'released' ? retry(w, existing) : drive(w, existing, Option.none())
}

const relayWith = (w: Wiring) =>
  Effect.fn('Sidequest.Settlement.relay')(function* (id: string, call: OperatorCall) {
    yield* Effect.annotateCurrentSpan({ 'settlement.intent': id, 'settlement.function': call.function })
    const data = operatorCalldata(call)
    // A stuck nonce below this one would hold it up: repair first, and relay anyway if the chain is out of reach.
    yield* repairAll(w).pipe(Effect.catchTag('ChainUnavailable', () => Effect.void))
    const existing = yield* w.intents.find(id)
    if (Option.isSome(existing)) return yield* resume(w, existing.value, data)
    const simulation = yield* simulate(w, data)
    if (!simulation.runs) return yield* new CallReverted({ function: call.function, reason: simulation.reason })
    const minimumNonce = yield* nonceAt(w, 'pending')
    const signer = w.account.address
    const intent = yield* w.intents.reserve({ id, signer, to: w.chain.operator, data, minimumNonce })
    return yield* resume(w, intent, data)
  })

/**
 * Sends `SidequestOperator` calls from Sidequest's relayer key, a Worker secret. Sidequest never signs for a person:
 * the calls carry the party's own signature, or are deadline functions anyone may call.
 *
 * Every call is an intent that holds one nonce. The intent is recorded before anything is signed, and each signed
 * transaction before it is broadcast, so a relay that stops anywhere is picked up by the next one: it looks at the
 * chain and carries on from what it finds. The same id with a different call is refused. A call that reverts in
 * simulation is refused before it takes a nonce.
 *
 * A nonce the chain never uses would hold up every later transaction, so the relayer repairs stuck intents (see
 * {@link RepairPolicy}): it signs the same call again at the same nonce with higher fees, or, once the call can no
 * longer succeed or the node keeps refusing it, releases the nonce with a transfer of nothing to itself and records
 * why. Every transaction of an intent shares its nonce, so the chain mines at most one of them: never two calls for
 * one intent, and never one intent's nonce for another's call. A released intent takes a fresh nonce only once the
 * release is mined, when its call is provably dead at the old one. Each relay first repairs what is stuck.
 */
export class Relayer extends Context.Service<
  Relayer,
  {
    readonly address: Address
    readonly relay: (id: string, call: OperatorCall) => Effect.Effect<Relayed, RelayError>
    /** Repairs every stuck intent and closes every mined one; one that cannot be repaired now waits for the next. */
    readonly repair: Effect.Effect<void, SettlementStoreError | ChainUnavailable>
  }
>()('Sidequest/Settlement/Relayer') {
  static readonly layer = (
    key: Redacted.Redacted<Hex>,
    chain: SettlementChain,
    policy: RepairPolicy = defaultRepairPolicy,
  ) =>
    Layer.effect(
      Relayer,
      Effect.gen(function* () {
        const account = privateKeyToAccount(Redacted.value(key))
        const w: Wiring = { rpc: yield* ChainRpc, intents: yield* RelayerIntents, account, chain, policy }
        return Relayer.of({ address: account.address, relay: relayWith(w), repair: repairAll(w) })
      }),
    )
}
