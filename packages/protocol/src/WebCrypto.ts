import { Crypto, Effect } from 'effect'

/** Effect's Crypto over Web Crypto, which browsers, Workers and Bun all provide. */
export const webCrypto = Crypto.make({
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    Effect.promise(() => globalThis.crypto.subtle.digest(algorithm, new Uint8Array(data))).pipe(
      Effect.map((buffer) => new Uint8Array(buffer)),
    ),
})
