import { Option, Predicate } from 'effect'

// The browser's WebAuthn as the passkey signer reaches it (`Signer.ts`, `PasskeyKit.ts`): only where the page is a
// secure context with `PublicKeyCredential`, looked for at each use like the extension.

/** The browser's WebAuthn, as the passkey signer uses it: nothing it returns is trusted. */
export interface PasskeyPort {
  readonly create: (options: CredentialCreationOptions) => Promise<unknown>
  readonly get: (options: CredentialRequestOptions) => Promise<unknown>
  /** False only when the browser says, before any prompt, that it cannot evaluate PRF. */
  readonly prfMaybeAvailable: () => Promise<boolean>
  /** Tells the passkey's provider a credential is of no use here, where the browser can (WebAuthn's Signal API). */
  readonly signalUnknown: (rpId: string, credentialId: string) => Promise<unknown>
}

/** What the browser says of PRF before any prompt (`getClientCapabilities`, where it has it): false only when it says
 * it lacks it. */
const prfMaybeAvailable = (): Promise<boolean> =>
  'getClientCapabilities' in PublicKeyCredential
    ? PublicKeyCredential.getClientCapabilities().then((capabilities) => capabilities['extension:prf'] !== false)
    : Promise.resolve(true)

/** Tells the passkey's provider the credential is of no use here, so it may offer to delete it, where the browser has
 * WebAuthn's Signal API; otherwise nothing. */
const signalUnknown = (rpId: string, credentialId: string): Promise<unknown> =>
  'signalUnknownCredential' in PublicKeyCredential
    ? PublicKeyCredential.signalUnknownCredential({ rpId, credentialId })
    : Promise.resolve()

/** The page's WebAuthn, or none where it has none. */
export const findAuthenticator = (target: Window): Option.Option<PasskeyPort> => {
  const credentials = target.navigator.credentials
  return target.isSecureContext && 'PublicKeyCredential' in target && Predicate.isObject(credentials)
    ? Option.some({
        create: (options) => credentials.create(options),
        get: (options) => credentials.get(options),
        prfMaybeAvailable,
        signalUnknown,
      })
    : Option.none()
}
