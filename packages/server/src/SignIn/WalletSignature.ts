import { Unavailable } from '@sidequest/protocol'
import { Effect, Option, Schema } from 'effect'
import {
  type Address,
  BaseError,
  type PublicClient,
  type Hex,
  hashMessage,
  HttpRequestError,
  isAddressEqual,
  recoverMessageAddress,
  TimeoutError,
} from 'viem'

/** ERC-1271's check, and the value it returns for a signature the account accepts. */
const erc1271 = [
  {
    type: 'function',
    name: 'isValidSignature',
    stateMutability: 'view',
    inputs: [
      { name: 'hash', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [{ name: 'magicValue', type: 'bytes4' }],
  },
] as const
const erc1271Accepted = '0x1626ba7e'

/** The chain answered the ERC-1271 call with no acceptance: the address has no code, or its check reverted. */
class NotAccepted extends Schema.TaggedError<NotAccepted>()('NotAccepted', {}) {}

/** The call did not reach the chain or timed out, as opposed to the chain answering that the signature is not valid. */
const unreachable = (cause: unknown) =>
  cause instanceof BaseError &&
  cause.walk((error) => error instanceof HttpRequestError || error instanceof TimeoutError) !== null

/**
 * Whether `address` signed `message` (EIP-191), asking `rpc` only when it must. A key's signature is recovered
 * locally, with no call to the chain; only when it does not recover to `address` is the address asked, as a contract
 * account, whether it accepts the signature (ERC-1271). An address with no code, or that refuses, did not sign. A
 * chain that does not answer is `Unavailable`.
 */
export const signatureCheck = (rpc: PublicClient) =>
  Effect.fn('Sidequest.SignIn.signedBy')(function* (address: Address, message: string, signature: Hex) {
    // A signature that recovers no key (not 65 bytes, or off the curve) may still be a contract account's.
    const recovered = yield* Effect.tryPromise({
      try: () => recoverMessageAddress({ message, signature }),
      catch: () => new NotAccepted(),
    }).pipe(Effect.option)
    if (Option.isSome(recovered) && isAddressEqual(recovered.value, address)) return true
    return yield* Effect.tryPromise({
      try: () =>
        rpc.readContract({
          address,
          abi: erc1271,
          functionName: 'isValidSignature',
          args: [hashMessage(message), signature],
        }),
      catch: (cause) => (unreachable(cause) ? new Unavailable() : new NotAccepted()),
    }).pipe(
      Effect.map((answer) => answer === erc1271Accepted),
      Effect.catchTag('NotAccepted', () => Effect.succeed(false)),
    )
  })
