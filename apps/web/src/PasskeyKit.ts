import { passkeyPrfInput, type SecretKey, secretKeyFromPrf } from '@sidequest/nostr'
import { webCrypto } from '@sidequest/protocol'
import { Crypto, Effect, Option, Predicate, Result } from 'effect'
import { Base64Url } from 'effect/encoding'
import { backupOf, keySigner } from './KeySigner.ts'
import type { KitSigner, SignerFailure } from './Signer.ts'
import type { PasskeyPort } from './Webauthn.ts'

// A Nostr key derived from a passkey (ADR-0005), part of the Nostr chunk (`NostrKit.ts`). WebAuthn's PRF extension
// evaluates the passkey's secret at Sidequest's fixed input, and `secretKeyFromPrf` (`@sidequest/nostr`) makes the key
// of the 32 bytes it answers. No server sees the ceremony: the challenge is random and nobody checks the assertion's
// signature, because the PRF output, which only the authenticator can compute and only after user verification, is
// the whole of what matters. The browser is not trusted to answer what was asked: an answer without a PRF output is a
// passkey that cannot derive, and says so.

/** A key a passkey derived: its signer, the credential that derives it, and the way to back the key up. */
export interface KitPasskey {
  readonly signer: KitSigner
  readonly credentialId: string
  /** The key's NIP-49 backup under a password. */
  readonly backup: (password: string) => Effect.Effect<string>
}

/** The relying party's name the passkey provider shows, and the account the passkey is listed under: an identifier
 * the same in every language, as a username is. */
const relyingPartyName = 'Sidequest'
const passkeyUserName = 'sidequest-nostr-key'
/** How long the browser's prompt waits for the person. */
const promptMillis = 120_000

const fail = (reason: SignerFailure) => ({ reason })

/** A refused prompt: cancelled or timed out (`NotAllowedError`), or anything else. */
const promptFailure = (error: unknown) =>
  fail(Predicate.hasProperty(error, 'name') && error.name === 'NotAllowedError' ? 'passkeyCancelled' : 'passkeyFailed')

/** The bytes of an `ArrayBuffer` or a view of one; none for anything else. */
const bytesOf = (buffer: unknown): Option.Option<Uint8Array> =>
  buffer instanceof ArrayBuffer
    ? Option.some(new Uint8Array(buffer))
    : ArrayBuffer.isView(buffer)
      ? Option.some(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength))
      : Option.none()

/** A copy WebAuthn takes as a `BufferSource`. */
const owned = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => Uint8Array.from(bytes)

const randomBytes = (length: number) =>
  Crypto.Crypto.use((crypto) => crypto.randomBytes(length)).pipe(
    // Crypto fails only for a negative or fractional size.
    Effect.orDie,
    Effect.map(owned),
    Effect.provideService(Crypto.Crypto, webCrypto),
  )

/** What a credential the browser answered says: its id, whether PRF is enabled for it, and the PRF output if any. */
interface Answered {
  readonly credentialId: string
  readonly rawId: Uint8Array
  readonly prfEnabled: boolean
  readonly maybePrfOutput: Option.Option<Uint8Array>
}

const field = (value: unknown, name: string): unknown => (Predicate.hasProperty(value, name) ? value[name] : undefined)

/** What every `PublicKeyCredential` has that this derivation reads. */
interface CredentialAnswer {
  readonly rawId: unknown
  readonly getClientExtensionResults: () => unknown
}

const isCredentialAnswer = (value: unknown): value is CredentialAnswer =>
  Predicate.hasProperty(value, 'rawId') &&
  Predicate.hasProperty(value, 'getClientExtensionResults') &&
  Predicate.isFunction(value.getClientExtensionResults)

/** The parts of a `PublicKeyCredential` this derivation reads; `passkeyFailed` for anything that is not one. */
const answeredBy = (credential: unknown) =>
  Effect.gen(function* () {
    if (!isCredentialAnswer(credential)) return yield* Effect.fail(fail('passkeyFailed'))
    const extensions = yield* Effect.try({
      try: () => credential.getClientExtensionResults(),
      catch: () => fail('passkeyFailed'),
    })
    const rawId = yield* Option.match(bytesOf(credential.rawId), {
      onNone: () => Effect.fail(fail('passkeyFailed')),
      onSome: Effect.succeed,
    })
    const prf = field(extensions, 'prf')
    const answered: Answered = {
      credentialId: Base64Url.encode(rawId),
      rawId,
      prfEnabled: field(prf, 'enabled') === true,
      maybePrfOutput: bytesOf(field(field(prf, 'results'), 'first')),
    }
    return answered
  })

/** The PRF extension's input: Sidequest's fixed salt, evaluated at create (where the authenticator can) and at get. */
const prfExtension = () => ({ prf: { eval: { first: owned(passkeyPrfInput()) } } })

/** An assertion of a passkey of `rpId`: the one `credential` names, or any the person picks when none. */
const assertion = (port: PasskeyPort, rpId: string, maybeCredential: Option.Option<Uint8Array>) =>
  Effect.gen(function* () {
    const challenge = yield* randomBytes(32)
    const answer = yield* Effect.tryPromise({
      try: () =>
        port.get({
          publicKey: {
            rpId,
            challenge,
            timeout: promptMillis,
            userVerification: 'required',
            allowCredentials: Option.match(maybeCredential, {
              onNone: () => [],
              onSome: (id) => [{ type: 'public-key', id: owned(id) }],
            }),
            extensions: prfExtension(),
          },
        }),
      catch: promptFailure,
    })
    return yield* answeredBy(answer)
  })

/** The key the PRF output derives, with its credential; `passkeyNoPrf` without an output. */
const derived = (credentialId: string, maybePrfOutput: Option.Option<Uint8Array>) =>
  Effect.gen(function* () {
    const output = yield* Option.match(maybePrfOutput, {
      onNone: () => Effect.fail(fail('passkeyNoPrf')),
      onSome: Effect.succeed,
    })
    // Derivation gives none only for an output that is not 32 bytes: the browser answered something PRF does not.
    const secret: SecretKey = yield* Option.match(secretKeyFromPrf(output), {
      onNone: () => Effect.fail(fail('passkeyFailed')),
      onSome: Effect.succeed,
    })
    const passkey: KitPasskey = {
      signer: keySigner('passkey', secret),
      credentialId,
      backup: (password) => backupOf(secret, password),
    }
    return passkey
  })

/** The key of a passkey of `rpId`: the remembered credential's, or (none) the one the person picks on any device. */
export const findPasskeySigner = (port: PasskeyPort, rpId: string, maybeCredentialId: Option.Option<string>) =>
  Effect.gen(function* () {
    const credential = Option.flatMap(maybeCredentialId, (id) => Result.getSuccess(Base64Url.decode(id)))
    const answered = yield* assertion(port, rpId, credential)
    return yield* derived(answered.credentialId, answered.maybePrfOutput)
  })

/**
 * Makes a discoverable passkey for `rpId`, with user verification required and PRF, and derives its key: from the PRF
 * output the creation answered where the authenticator evaluates PRF at creation, else from an assertion of the new
 * passkey where it says PRF is enabled. A browser that says beforehand it lacks PRF makes no passkey; a passkey made
 * that cannot derive is reported to its provider as of no use, and the answer is `passkeyNoPrf`.
 */
export const createPasskeySigner = (port: PasskeyPort, rpId: string) =>
  Effect.gen(function* () {
    const prfMaybe = yield* Effect.tryPromise(() => port.prfMaybeAvailable()).pipe(Effect.orElseSucceed(() => true))
    if (!prfMaybe) return yield* Effect.fail(fail('passkeyNoPrf'))
    const userId = yield* randomBytes(16)
    const challenge = yield* randomBytes(32)
    const answer = yield* Effect.tryPromise({
      try: () =>
        port.create({
          publicKey: {
            rp: { id: rpId, name: relyingPartyName },
            user: { id: userId, name: passkeyUserName, displayName: passkeyUserName },
            challenge,
            pubKeyCredParams: [
              { type: 'public-key', alg: -7 },
              { type: 'public-key', alg: -8 },
              { type: 'public-key', alg: -257 },
            ],
            authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
            attestation: 'none',
            timeout: promptMillis,
            extensions: prfExtension(),
          },
        }),
      catch: promptFailure,
    })
    const created = yield* answeredBy(answer)
    const maybeOutput = Option.isSome(created.maybePrfOutput)
      ? created.maybePrfOutput
      : created.prfEnabled
        ? (yield* assertion(port, rpId, Option.some(created.rawId))).maybePrfOutput
        : Option.none<Uint8Array>()
    return yield* derived(created.credentialId, maybeOutput).pipe(
      Effect.tapError(({ reason }) =>
        reason === 'passkeyNoPrf'
          ? Effect.ignore(Effect.tryPromise(() => port.signalUnknown(rpId, created.credentialId)))
          : Effect.void,
      ),
    )
  })
