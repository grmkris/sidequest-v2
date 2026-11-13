import { Schema } from 'effect'

/** Why NIP-44 v2 would not encrypt or decrypt: the peer, the plaintext's size, or something about the payload. */
export class Nip44Refused extends Schema.TaggedError<Nip44Refused>()('Nip44Refused', {
  reason: Schema.Literals([
    'badPublicKey',
    'plaintextLength',
    'notWellFormed',
    'unknownVersion',
    'payloadLength',
    'badBase64',
    'badMac',
    'badPadding',
  ]),
}) {}
