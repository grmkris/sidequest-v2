import { Effect } from 'effect'
import { type Entropy, freshEntropy } from './Entropy.ts'
import { authored, type EventTemplate, type NostrEvent, Signature } from './Event.ts'
import { eventIdOf } from './EventHash.ts'
import { bytesOf, hexOf } from './Hex.ts'
import { publicKeyOf, type SecretKey } from './Keys.ts'
import { schnorrSign } from './Schnorr.ts'

/** Signs a template as the secret key's owner, with the given BIP-340 auxiliary randomness. Deterministic. */
export const finalizeEvent = (template: EventTemplate, secret: SecretKey, auxRand: Entropy): NostrEvent => {
  const unsigned = authored(publicKeyOf(secret), template)
  const id = eventIdOf(unsigned)
  // A BIP-340 signature is always 64 bytes.
  return { id, ...unsigned, sig: Signature.make(hexOf(schnorrSign(bytesOf(id), secret, auxRand))) }
}

/** Signs a template with auxiliary randomness from the host's `Crypto` service. */
export const signEvent = Effect.fnUntraced(function* (template: EventTemplate, secret: SecretKey) {
  return finalizeEvent(template, secret, yield* freshEntropy)
})
