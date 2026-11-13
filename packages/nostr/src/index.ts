// Nostr's core for Sidequest: NIP-01 events, BIP-340 keys and signatures, NIP-19 names and NIP-98 HTTP auth. Private
// messaging (NIP-44, NIP-59) is `@sidequest/nostr/private`; Sidequest's event kinds are `@sidequest/nostr/vocabulary`.
export { InvalidBech32 } from './Bech32.ts'
export { Entropy, freshEntropy } from './Entropy.ts'
export { EventId, EventTemplate, Kind, NostrEvent, Signature, Tag, UnsignedEvent } from './Event.ts'
export { eventIdOf, serializeEvent } from './EventHash.ts'
export {
  httpAuthHeader,
  httpAuthKind,
  HttpAuthRefused,
  type HttpRequestFacts,
  httpAuthTemplate,
  verifyHttpAuth,
} from './HttpAuth.ts'
export { PublicKey, publicKeyOf, SecretKey } from './Keys.ts'
export { type BareEntity, decodeNip19, encodeNote, encodeNpub, encodeNsec, UnsupportedEntity } from './Nip19.ts'
export { finalizeEvent, signEvent } from './Sign.ts'
export { InvalidEvent, verifyEvent } from './Verify.ts'
