import { createHmac } from 'node:crypto'
import { Result } from 'effect'
import { Base64Url } from 'effect/encoding'
import type { PasskeyPort } from '../src/Webauthn.ts'

// Doubles of what the browser gives the signers: `localStorage`, and WebAuthn with a passkey provider.

/** `localStorage` as a map, recording every value ever written. */
export const memoryStorage = () => {
  const items = new Map<string, string>()
  const written: Array<string> = []
  const storage: Storage = {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => {
      items.delete(key)
    },
    setItem: (key, value) => {
      written.push(value)
      items.set(key, value)
    },
  }
  return { storage, items, written }
}

const bytes = (source: BufferSource | Uint8Array | undefined): Uint8Array =>
  source === undefined
    ? new Uint8Array()
    : ArrayBuffer.isView(source)
      ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
      : new Uint8Array(source)

const idOf = (raw: Uint8Array) => Base64Url.encode(raw)
const rawOf = (id: string) => Result.getOrElse(Base64Url.decode(id), () => new Uint8Array())

/** A `PublicKeyCredential` as far as the signer reads one: its raw id and its PRF results. */
const answer = (raw: Uint8Array, prfResults: Record<string, unknown>) => ({
  rawId: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
  getClientExtensionResults: () => ({ prf: prfResults }),
})

/** What a passkey provider can do: evaluate PRF at all, evaluate it at creation already, or say up front it cannot. */
export interface ProviderTraits {
  readonly prf?: boolean
  readonly prfAtCreate?: boolean
  readonly saysNoPrf?: boolean
  /** Every prompt fails with this `DOMException` name, as when the person cancels (`NotAllowedError`). */
  readonly refusal?: string
}

/**
 * A passkey provider behind WebAuthn, its passkeys shared by every browser given the same double (as a synced
 * provider's are): each passkey has a random secret, and its PRF is HMAC-SHA256 of the input under it, as CTAP's
 * `hmac-secret` is. It records what it was asked, and the credentials it was told are of no use.
 */
export const passkeyProvider = (traits: ProviderTraits = {}) => {
  const secrets = new Map<string, Uint8Array>()
  const requests: Array<CredentialRequestOptions> = []
  const created: Array<CredentialCreationOptions> = []
  const signalled: Array<string> = []
  const prf = traits.prf ?? true
  const evaluate = (id: string, input: BufferSource | Uint8Array | undefined) =>
    new Uint8Array(
      createHmac('sha256', secrets.get(id) ?? new Uint8Array(32))
        .update(bytes(input))
        .digest(),
    )
  const refuse = () =>
    traits.refusal === undefined ? undefined : Promise.reject(new DOMException('refused', traits.refusal))
  const port: PasskeyPort = {
    create: (options) => {
      created.push(options)
      const refused = refuse()
      if (refused !== undefined) return refused
      const raw = crypto.getRandomValues(new Uint8Array(16))
      secrets.set(idOf(raw), crypto.getRandomValues(new Uint8Array(32)))
      const input = options.publicKey?.extensions?.prf?.eval?.first
      return Promise.resolve(
        answer(
          raw,
          prf
            ? {
                enabled: true,
                ...(traits.prfAtCreate === true ? { results: { first: evaluate(idOf(raw), input) } } : {}),
              }
            : {},
        ),
      )
    },
    get: (options) => {
      requests.push(options)
      const refused = refuse()
      if (refused !== undefined) return refused
      const allowed = options.publicKey?.allowCredentials ?? []
      const id = allowed.length > 0 ? idOf(bytes(allowed[0]?.id)) : [...secrets.keys()][0]
      if (id === undefined || !secrets.has(id)) return Promise.reject(new DOMException('none', 'NotAllowedError'))
      const input = options.publicKey?.extensions?.prf?.eval?.first
      return Promise.resolve(answer(rawOf(id), prf ? { results: { first: evaluate(id, input) } } : {}))
    },
    prfMaybeAvailable: () => Promise.resolve(traits.saysNoPrf !== true),
    signalUnknown: (_rpId, credentialId) => {
      signalled.push(credentialId)
      return Promise.resolve()
    },
  }
  /** The PRF output the passkey `id` gives for `input`, as the authenticator computes it. */
  const prfOf = (id: string, input: Uint8Array) => evaluate(id, input)
  return { port, secrets, requests, created, signalled, prfOf }
}
