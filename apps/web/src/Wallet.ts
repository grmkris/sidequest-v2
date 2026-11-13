import { type TypedData, WalletAddress, WalletSignature } from '@sidequest/protocol'

type WalletAddress = typeof WalletAddress.Type
type WalletSignature = typeof WalletSignature.Type
import { Context, Duration, Effect, Layer, Option, Predicate, Schedule, Schema } from 'effect'
import { arcChainHex, arcChainId, arcChainParameters } from './Chain.ts'

// The wallet the person's browser injects, spoken to through EIP-1193 only: `window.ethereum`, or the first wallet
// that answers an EIP-6963 discovery. No wallet library: the site needs seven requests.

/** An EIP-1193 provider: one `request` method. */
export interface Eip1193Provider {
  readonly request: (args: { readonly method: string; readonly params?: ReadonlyArray<unknown> }) => Promise<unknown>
}

/** No wallet is installed in this browser. */
export class NoWallet extends Schema.TaggedError<NoWallet>()('NoWallet', {}) {}
/** The person said no in their wallet (EIP-1193 code 4001). */
export class WalletRejected extends Schema.TaggedError<WalletRejected>()('WalletRejected', {}) {}
/** The wallet failed in some other way, or answered with something that is not what was asked for. */
export class WalletFailed extends Schema.TaggedError<WalletFailed>()('WalletFailed', {
  code: Schema.optionalKey(Schema.Number),
}) {}
export type WalletError = NoWallet | WalletRejected | WalletFailed

/** A transaction is not mined yet. */
class Pending extends Schema.TaggedError<Pending>()('Pending', {}) {}

/** The wallet does not know the chain it was asked to switch to (EIP-3326 code 4902). */
class UnknownChain extends Schema.TaggedError<UnknownChain>()('UnknownChain', {}) {}

/** A transaction the server prepared for the wallet to send itself: on `chainId`, to `to`, with calldata `data`. */
export interface PreparedCall {
  readonly chainId: number
  readonly to: string
  readonly data: string
}

/** One log of a mined transaction: the contract that emitted it and its topics. */
export const ReceiptLog = Schema.Struct({ address: Schema.String, topics: Schema.Array(Schema.String) })
export type ReceiptLog = typeof ReceiptLog.Type

/** The account a wallet connected and the chain it is on. */
export const Connection = Schema.Struct({ address: WalletAddress, chainId: Schema.Int })
export type Connection = typeof Connection.Type

export class Wallet extends Context.Service<
  Wallet,
  {
    /** Ask the wallet for an account, and read its chain. */
    readonly connect: Effect.Effect<Connection, WalletError>
    /** Move the wallet to Arc testnet, adding the chain first if the wallet does not know it. */
    readonly switchToArc: Effect.Effect<void, WalletError>
    /** `eth_signTypedData_v4` of typed data the server prepared, on the chain its domain names. */
    readonly signTypedData: (address: WalletAddress, data: TypedData) => Effect.Effect<WalletSignature, WalletError>
    /** `eth_signTypedData_v4` of typed data already in the wallet's JSON, `EIP712Domain` type included, on `chainId`:
     * a statement with no verifying contract, such as the link of a Nostr key. */
    readonly signTypedDataJson: (
      address: WalletAddress,
      chainId: number,
      json: string,
    ) => Effect.Effect<WalletSignature, WalletError>
    /** `eth_sendTransaction` of a call the server prepared, from `address`, on its chain; answers the hash. */
    readonly sendTransaction: (address: WalletAddress, call: PreparedCall) => Effect.Effect<string, WalletError>
    /** A transaction's logs once it is mined (`eth_getTransactionReceipt`), none while it is pending; reverted, it
     * fails. */
    readonly receiptLogs: (hash: string) => Effect.Effect<Option.Option<ReadonlyArray<ReceiptLog>>, WalletError>
  }
>()('@sidequest/web/Wallet') {}

const codeOf = (cause: unknown): Option.Option<number> =>
  Predicate.hasProperty(cause, 'code') && Predicate.isNumber(cause.code) ? Option.some(cause.code) : Option.none()

const walletErrorOf = (cause: unknown): WalletRejected | WalletFailed | UnknownChain =>
  Option.match(codeOf(cause), {
    onNone: () => new WalletFailed({}),
    onSome: (code) =>
      code === 4001 ? new WalletRejected() : code === 4902 ? new UnknownChain() : new WalletFailed({ code }),
  })

const decodeOr = <A>(schema: Schema.Decoder<A>) =>
  Effect.fnUntraced(function* (value: unknown) {
    return yield* Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => new WalletFailed({})))
  })

const ChainIdHex = Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]+$/u))
const decodeAccounts = decodeOr(Schema.NonEmptyArray(WalletAddress))
const decodeChain = decodeOr(ChainIdHex)
const decodeSignature = decodeOr(WalletSignature)
const decodeHash = decodeOr(Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{64}$/u)))
const decodeReceipt = decodeOr(Schema.NullOr(Schema.Struct({ status: Schema.String, logs: Schema.Array(ReceiptLog) })))

const domainType = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
]

/** Typed data as `eth_signTypedData_v4` takes it: with the `EIP712Domain` type its domain is hashed by. */
const typedDataJson = (data: TypedData): string =>
  JSON.stringify({ ...data, types: { EIP712Domain: domainType, ...data.types } })

/** The wallet service over a provider that `findProvider` looks for at each request, as a wallet may inject itself
 * after the page loaded. */
export const makeWallet = (findProvider: Effect.Effect<Option.Option<Eip1193Provider>>): Wallet['Service'] => {
  const provider = Effect.flatMap(findProvider, (found) =>
    Option.match(found, { onNone: () => Effect.fail(new NoWallet()), onSome: Effect.succeed }),
  )
  const request = (method: string, params?: ReadonlyArray<unknown>) =>
    Effect.flatMap(provider, (found) =>
      Effect.tryPromise({
        try: () => found.request(params === undefined ? { method } : { method, params }),
        catch: walletErrorOf,
      }),
    )
  const call = (method: string, params?: ReadonlyArray<unknown>) =>
    request(method, params).pipe(Effect.catchTag('UnknownChain', () => Effect.fail(new WalletFailed({ code: 4902 }))))
  const chainId = call('eth_chainId').pipe(
    Effect.flatMap(decodeChain),
    Effect.map((hex) => Number.parseInt(hex, 16)),
  )
  const switchToArc = request('wallet_switchEthereumChain', [{ chainId: arcChainHex }]).pipe(
    Effect.catchTag('UnknownChain', () =>
      request('wallet_addEthereumChain', [arcChainParameters]).pipe(
        Effect.andThen(request('wallet_switchEthereumChain', [{ chainId: arcChainHex }])),
      ),
    ),
    Effect.catchTag('UnknownChain', () => Effect.fail(new WalletFailed({ code: 4902 }))),
    Effect.asVoid,
  )
  const ensureChain = (target: number) =>
    Effect.flatMap(chainId, (current) => (current === target || target !== arcChainId ? Effect.void : switchToArc))
  const signJson = (address: WalletAddress, onChain: number, json: string) =>
    ensureChain(onChain).pipe(
      Effect.andThen(call('eth_signTypedData_v4', [address, json])),
      Effect.flatMap(decodeSignature),
    )
  return Wallet.of({
    connect: Effect.gen(function* () {
      const accounts = yield* call('eth_requestAccounts').pipe(Effect.flatMap(decodeAccounts))
      return { address: accounts[0], chainId: yield* chainId }
    }).pipe(Effect.withSpan('Sidequest.Web.Wallet.connect')),
    switchToArc: switchToArc.pipe(Effect.withSpan('Sidequest.Web.Wallet.switchToArc')),
    signTypedData: (address, data) =>
      signJson(address, data.domain.chainId, typedDataJson(data)).pipe(
        Effect.withSpan('Sidequest.Web.Wallet.signTypedData'),
      ),
    signTypedDataJson: (address, onChain, json) =>
      signJson(address, onChain, json).pipe(Effect.withSpan('Sidequest.Web.Wallet.signTypedDataJson')),
    sendTransaction: (address, { chainId: onChain, to, data }) =>
      ensureChain(onChain).pipe(
        Effect.andThen(call('eth_sendTransaction', [{ from: address, to, data }])),
        Effect.flatMap(decodeHash),
        Effect.withSpan('Sidequest.Web.Wallet.sendTransaction'),
      ),
    receiptLogs: (hash) =>
      call('eth_getTransactionReceipt', [hash]).pipe(
        Effect.flatMap(decodeReceipt),
        Effect.flatMap((receipt) => {
          if (receipt === null) {
            return Effect.succeed(Option.none())
          }
          return receipt.status === '0x1'
            ? Effect.succeed(Option.some(receipt.logs))
            : Effect.fail(new WalletFailed({}))
        }),
      ),
  })
}

const isProvider = (value: unknown): value is Eip1193Provider =>
  Predicate.hasProperty(value, 'request') && Predicate.isFunction(value.request)

const announcedProvider = (event: Event): Option.Option<Eip1193Provider> => {
  const detail: unknown = event instanceof CustomEvent ? event.detail : undefined
  return Predicate.hasProperty(detail, 'provider') && isProvider(detail.provider)
    ? Option.some(detail.provider)
    : Option.none()
}

/** The browser's wallet: the first one that answers an EIP-6963 request (wallets answer synchronously), else the
 * provider injected as `window.ethereum`. */
const discoverProvider = (target: Window): Option.Option<Eip1193Provider> => {
  const announced: Array<Eip1193Provider> = []
  const listener = (event: Event) => Option.map(announcedProvider(event), (found) => announced.push(found))
  target.addEventListener('eip6963:announceProvider', listener)
  target.dispatchEvent(new Event('eip6963:requestProvider'))
  target.removeEventListener('eip6963:announceProvider', listener)
  const injected: unknown = 'ethereum' in target ? target.ethereum : undefined
  return Option.orElse(Option.fromNullishOr(announced[0]), () =>
    isProvider(injected) ? Option.some(injected) : Option.none(),
  )
}

/** A transaction's logs once it is mined, asking the wallet every two seconds for up to three minutes. */
export const minedLogs = (hash: string) =>
  Wallet.use((wallet) => wallet.receiptLogs(hash)).pipe(
    Effect.flatMap(Option.match({ onNone: () => Effect.fail(new Pending()), onSome: Effect.succeed })),
    Effect.retry({
      schedule: Schedule.spaced(Duration.seconds(2)),
      times: 90,
      while: (error) => error instanceof Pending,
    }),
  )

export const walletLayer = (target: Window) =>
  Layer.succeed(Wallet, makeWallet(Effect.sync(() => discoverProvider(target))))
