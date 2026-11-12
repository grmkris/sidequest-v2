import {
  AccountRef,
  SignInRefused,
  type SignInRefusal,
  UsdcOnArcTestnet,
  type UnixSeconds,
  WalletAddress,
} from '@sidequest/protocol'
import { DateTime, Effect, Schema } from 'effect'
import { getAddress, type Address } from 'viem'
import { createSiweMessage, parseSiweMessage } from 'viem/siwe'

// Sign-In with Ethereum (EIP-4361, https://eips.ethereum.org/EIPS/eip-4361) for Sidequest: the message a wallet signs,
// bound to the site that asked for it, Arc testnet and a nonce the server issued, and the checks a signed one passes.

/** The network phase 1 settles on (the asset registry's), as a CAIP-2 id and as its EIP-155 chain id. */
const network = UsdcOnArcTestnet.network
export const chainId = Number(network.slice(network.indexOf(':') + 1))

/** How long a challenge may be signed and sent back. */
export const challengeSeconds = 300

/** How far a wallet's clock may run ahead of the server's. */
const skewSeconds = 60

/** Where a request came from, as SIWE names it: the scheme, the authority (`domain`, with any port) and the origin. */
export interface Site {
  readonly scheme: string
  readonly domain: string
  readonly origin: string
}

export const siteOf = (url: URL): Site => ({ scheme: url.protocol.slice(0, -1), domain: url.host, origin: url.origin })

/** A wallet as a CAIP-10 account on the phase 1 network, its address in EIP-55 form. */
export const walletRef = (address: Address): AccountRef => AccountRef.make(`${network}:${getAddress(address)}`)

const toSeconds = (date: Date): UnixSeconds => Math.floor(date.getTime() / 1000)
const dateOf = (seconds: UnixSeconds) => DateTime.toDateUtc(DateTime.makeUnsafe(seconds * 1000))

/** The message a wallet signs to sign in to `site`, issued at `issuedAt` and valid for {@link challengeSeconds}. */
export const challengeMessage = (input: {
  readonly site: Site
  readonly address: Address
  readonly nonce: string
  readonly issuedAt: UnixSeconds
}) =>
  // The site comes from the request's own URL and the nonce from the server, so SIWE accepts them: a failure is a defect.
  Effect.try(() =>
    createSiweMessage({
      scheme: input.site.scheme,
      domain: input.site.domain,
      uri: input.site.origin,
      address: getAddress(input.address),
      statement: 'Sign in to Sidequest.',
      version: '1',
      chainId,
      nonce: input.nonce,
      issuedAt: dateOf(input.issuedAt),
      expirationTime: dateOf(input.issuedAt + challengeSeconds),
    }),
  ).pipe(Effect.orDie)

/** The fields of a SIWE message that sign-in reads; any other is covered by the signature but not checked. */
const SiweFields = Schema.Struct({
  scheme: Schema.optional(Schema.String),
  domain: Schema.String,
  address: WalletAddress,
  uri: Schema.String,
  version: Schema.Literal('1'),
  chainId: Schema.Number,
  nonce: Schema.String,
  issuedAt: Schema.Date,
  expirationTime: Schema.optional(Schema.Date),
  notBefore: Schema.optional(Schema.Date),
})

/** What a message that passed its checks says: who signs in, with which nonce. */
export interface CheckedMessage {
  readonly address: Address
  readonly nonce: string
}

const refused = (reason: SignInRefusal) => new SignInRefused({ reason })

const originOf = (uri: string) => (URL.canParse(uri) ? new URL(uri).origin : undefined)

/** Whether the message names this site: its scheme (`https` when it names none), its authority and its origin. */
const siteRefusal = (fields: typeof SiweFields.Type, site: Site): SignInRefusal | undefined => {
  if (fields.domain !== site.domain || (fields.scheme ?? 'https') !== site.scheme) return 'wrong_domain'
  if (originOf(fields.uri) !== site.origin) return 'wrong_uri'
  return fields.chainId === chainId ? undefined : 'wrong_chain'
}

/** Whether the message is in its time at `now`: issued recently and not ahead of the clock, and within its bounds. */
const timeRefusal = (fields: typeof SiweFields.Type, now: UnixSeconds): SignInRefusal | undefined => {
  const issuedAt = toSeconds(fields.issuedAt)
  if (issuedAt > now + skewSeconds) return 'issued_in_future'
  if (issuedAt < now - challengeSeconds - skewSeconds) return 'stale'
  if (fields.notBefore !== undefined && toSeconds(fields.notBefore) > now + skewSeconds) return 'not_yet_valid'
  if (fields.expirationTime !== undefined && toSeconds(fields.expirationTime) <= now) return 'expired'
  return undefined
}

/**
 * Check a signed-in-to-be message before its signature: it is an EIP-4361 message for `site` on Arc testnet, issued
 * no more than a challenge's lifetime ago and not expired at `now`. The nonce and the signature are checked after.
 */
export const checkMessage = Effect.fnUntraced(function* (message: string, site: Site, now: UnixSeconds) {
  const fields = yield* Schema.decodeUnknownEffect(SiweFields)(parseSiweMessage(message)).pipe(
    Effect.mapError(() => refused('malformed')),
  )
  const refusal = siteRefusal(fields, site) ?? timeRefusal(fields, now)
  if (refusal !== undefined) return yield* refused(refusal)
  const checked: CheckedMessage = { address: getAddress(fields.address), nonce: fields.nonce }
  return checked
})
