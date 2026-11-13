import {
  decryptNip49,
  type EventTemplate,
  eventIdOf,
  freshNip49,
  freshSecretKey,
  PublicKey,
  publicKeyOf,
  type SecretKey,
  signEvent,
  verifyEvent,
} from '@sidequest/nostr'
import {
  type BuildOptions,
  buildSidequestEvent,
  type Delivered,
  deliveryHashOf,
  deliveryNote,
  DeliveryNoteContent,
  jobAccept,
  jobProposal,
  jobRequest,
  jobReview,
  type KindSpec,
  profileTemplate,
  ServiceListing,
  serviceListingTemplate,
  statement,
  walletLink,
  walletLinkTypedData,
} from '@sidequest/nostr/vocabulary'
import { localRoomSigner, type RoomSigner, RoomSignerRefused } from '@sidequest/nostr/rooms'
import { type NetworkRef, type Terms, termsDigest, webCrypto } from '@sidequest/protocol'
import { Crypto, Effect, Option, Predicate, Schema } from 'effect'
import type { KitSigner, Nip07Nip44, Nip07Provider, SignerFailure } from './Signer.ts'

// The Nostr code of the browser, loaded as one chunk the first time a signer is used (see `Signer.ts`): the two
// signers, and the templates the pages sign. It imports nothing of the website's own modules but types, so
// the bundler has nothing of the initial bundle to split out and share with it.

/**
 * scrypt's cost for a key made here: `log_n = 16`, NIP-49's common choice. It takes 64 MiB and, in noble's JavaScript,
 * about a second on a laptop and a few on a phone, once when the key is made and once at each unlock; above that a
 * phone's tab may run out of memory. The person's password is the rest of the protection.
 */
export const localLogN = 16

const fail = (reason: SignerFailure) => ({ reason })

const isNip44 = (value: unknown): value is Nip07Nip44 =>
  Predicate.hasProperty(value, 'encrypt') &&
  Predicate.isFunction(value.encrypt) &&
  Predicate.hasProperty(value, 'decrypt') &&
  Predicate.isFunction(value.decrypt)

const refusedAs = (reason: RoomSignerRefused['reason']) => () => new RoomSignerRefused({ reason })

/** A text the extension answered, or `untrusted`. */
const textOf = (answer: unknown) =>
  Predicate.isString(answer) ? Effect.succeed(answer) : Effect.fail(new RoomSignerRefused({ reason: 'untrusted' }))

/** The room signer over an extension's `nip44`, or none when it has none. The extension keeps its conversation keys, so
 * it cannot disclose one message's keys: a disclosure needs a key held in the browser. */
const extensionRoomSigner = (
  provider: Nip07Provider,
  publicKey: PublicKey,
  signWith: KitSigner['signEvent'],
): Option.Option<RoomSigner> =>
  Option.map(Option.liftPredicate(provider.nip44, isNip44), (nip44) => ({
    publicKey,
    signEvent: (template) => Effect.mapError(signWith(template), refusedAs('refused')),
    encrypt: (peer, plaintext) =>
      Effect.tryPromise({ try: () => nip44.encrypt(peer, plaintext), catch: refusedAs('refused') }).pipe(
        Effect.flatMap(textOf),
      ),
    decrypt: (peer, payload) =>
      Effect.tryPromise({ try: () => nip44.decrypt(peer, payload), catch: refusedAs('refused') }).pipe(
        Effect.flatMap(textOf),
      ),
    messageKeys: () => Effect.fail(new RoomSignerRefused({ reason: 'cannotDisclose' })),
  }))

/** A NIP-07 extension's signer. The extension is not trusted: its key must be a key, and every event it returns must
 * verify and be exactly the template it was given, signed by that key. */
export const nip07Signer = Effect.fnUntraced(function* (provider: Nip07Provider) {
  const answered = yield* Effect.tryPromise({
    try: () => provider.getPublicKey(),
    catch: () => fail('extensionRefused'),
  })
  const publicKey = yield* Schema.decodeUnknownEffect(PublicKey)(answered).pipe(
    Effect.mapError(() => fail('extensionUntrusted')),
  )
  const expected = (template: EventTemplate) => eventIdOf({ pubkey: publicKey, ...template })
  const signEventWith: KitSigner['signEvent'] = (template) =>
    Effect.gen(function* () {
      const signed = yield* Effect.tryPromise({
        try: () => provider.signEvent({ ...template, tags: template.tags.map((tag) => [...tag]) }),
        catch: () => fail('extensionRefused'),
      })
      const event = yield* Effect.fromResult(verifyEvent(signed)).pipe(
        Effect.mapError(() => fail('extensionUntrusted')),
      )
      if (event.pubkey !== publicKey || event.id !== expected(template)) {
        return yield* Effect.fail(fail('extensionUntrusted'))
      }
      return event
    })
  const signer: KitSigner = {
    kind: 'nip07',
    publicKey,
    signEvent: signEventWith,
    maybeRoomSigner: extensionRoomSigner(provider, publicKey, signEventWith),
  }
  return signer
})

/** The signer of a key held in this closure, and nowhere else. */
const localSigner = (secret: SecretKey): KitSigner => ({
  kind: 'local',
  publicKey: publicKeyOf(secret),
  signEvent: (template) => signEvent(template, secret).pipe(Effect.provideService(Crypto.Crypto, webCrypto)),
  maybeRoomSigner: Option.some(localRoomSigner(secret, webCrypto)),
})

/** A fresh key and its NIP-49 backup under `password`. Nobody has handled the key in the clear, so the backup says
 * so (`secure`). */
export const createLocalSigner = Effect.fnUntraced(
  function* (password: string) {
    const secret = yield* freshSecretKey
    // Encrypting refuses only a cost outside NIP-49's range, and this one is fixed inside it.
    const ncryptsec = yield* Effect.orDie(freshNip49(secret, password, { logN: localLogN, keySecurity: 'secure' }))
    return { signer: localSigner(secret), ncryptsec }
  },
  Effect.provideService(Crypto.Crypto, webCrypto),
)

/** The signer of the key an `ncryptsec` holds, opened with its password. */
export const openLocalSigner = (ncryptsec: string, password: string) =>
  decryptNip49(ncryptsec, password).pipe(
    Effect.map((opened) => localSigner(opened.secret)),
    Effect.mapError((refused) => fail(refused.reason === 'wrongPassword' ? 'wrongPassword' : 'notABackup')),
  )

/** A kind-0 profile with the person's name. */
export const profileOf = (name: string, createdAt: number): EventTemplate => profileTemplate(name, createdAt)

/** The event template for `input` as content of the kind `spec` describes; none when the vocabulary refuses it. */
const templateOf = <C>(
  spec: KindSpec<C>,
  input: unknown,
  options: BuildOptions,
): Effect.Effect<Option.Option<EventTemplate>> =>
  Schema.decodeUnknownEffect(spec.content)(input).pipe(
    Effect.flatMap((content) => buildSidequestEvent(spec, content, options)),
    Effect.option,
  )

/** A buyer's request: what they need and until when it is open. Its event id becomes the job's id. */
export const requestTemplate = (input: unknown, createdAt: number) => templateOf(jobRequest, input, { createdAt })

/** A bidder's proposal for `job`: the terms, their digest (computed here, as an accept binds it), where to pay and
 * until when it stands; `previous` names the proposal it revises. */
export const proposalTemplate = (
  input: {
    readonly job: string
    readonly buyer: string
    readonly terms: Terms
    readonly payTo: string
    readonly validUntil: number
    readonly previous?: string
  },
  createdAt: number,
) =>
  Effect.flatMap(termsDigest(input.terms), (digest) =>
    templateOf(jobProposal, { ...input, termsDigest: digest }, { createdAt }),
  )

/** The buyer accepts one proposal on its network: a signal that binds nothing until the escrow is funded. */
export const acceptTemplate = (
  input: {
    readonly job: string
    readonly proposal: string
    readonly termsDigest: string
    readonly worker: string
    readonly network: NetworkRef
  },
  createdAt: number,
) => {
  const { network, ...content } = input
  return templateOf(jobAccept, content, { createdAt, network })
}

/** A statement on the record about a job: withdrawing a request or a proposal, or the buyer's reason for a rejection. */
export const statementTemplate = (input: unknown, createdAt: number) => templateOf(statement, input, { createdAt })

const DeliveredInput = Schema.Struct({
  job: DeliveryNoteContent.fields.job,
  url: DeliveryNoteContent.fields.url,
  note: DeliveryNoteContent.fields.note,
})

/** The hash the worker's note states and their wallet signs onto the escrow (see `deliveryHashOf`); none when the
 * vocabulary would refuse what was delivered as a note's content. */
export const deliveryHash = (input: {
  readonly job: string
  readonly url?: string
  readonly note?: string
}): Effect.Effect<Option.Option<string>> =>
  Schema.decodeUnknownEffect(DeliveredInput)(input).pipe(
    Effect.flatMap((delivered: Delivered) => deliveryHashOf(delivered)),
    Effect.option,
  )

/** The worker's delivery note: the job's buyer, the hash of what was delivered and where it is, on the job's network. */
export const deliveryNoteTemplate = (input: unknown, network: NetworkRef, createdAt: number) =>
  templateOf(deliveryNote, input, { createdAt, network })

/** One side's review of the other once the job settled: a rating from 1 to 5 and a text. */
export const reviewTemplate = (input: unknown, createdAt: number) => templateOf(jobReview, input, { createdAt })

/** A seller's NIP-99 listing; publishing it again under the same slug replaces the earlier version. */
export const listingTemplate = (input: unknown, createdAt: number): Effect.Effect<Option.Option<EventTemplate>> =>
  Schema.decodeUnknownEffect(ServiceListing)(input).pipe(
    Effect.map((listing) => serviceListingTemplate(listing, createdAt)),
    Effect.option,
  )

/** The EIP-712 typed data a wallet signs to link `pubkey`, as `eth_signTypedData_v4` takes it. */
export const walletLinkTypedDataJson = (pubkey: string, issuedAt: number, chainId: number): string =>
  JSON.stringify(walletLinkTypedData(PublicKey.make(pubkey), issuedAt, chainId))

/** The wallet-link event's template from the account, when the wallet signed and its signature; none when the
 * vocabulary would refuse them (a wallet whose signature or account is not what a link carries). */
export const walletLinkOf = (content: {
  readonly address: string
  readonly issuedAt: number
  readonly walletSignature: string
}): Effect.Effect<Option.Option<EventTemplate>> =>
  Schema.decodeUnknownEffect(walletLink.content)(content).pipe(
    Effect.flatMap((decoded) => buildSidequestEvent(walletLink, decoded, { createdAt: decoded.issuedAt })),
    Effect.option,
  )
