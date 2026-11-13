/**
 * Sidequest's event kinds: one block, 8410–8420, in NIP-01's regular range and not in the NIPs' kind registry. They
 * live here alone so the block can move in one edit. It moved once, from 8210–8220: on 13 November 2026 public relays
 * already held another client's kind 8211, and held nothing in 8410–8421. One kind per consequential action lets a
 * NIP-46 signer scope an agent's key per action (`sign_event:<kind>`). 8417 and 8420 are kept free.
 */
export const sidequestKinds = {
  walletLink: 8410,
  request: 8411,
  proposal: 8412,
  accept: 8413,
  deliveryNote: 8414,
  statement: 8415,
  review: 8416,
  grant: 8418,
  revocation: 8419,
} as const
export type SidequestKind = (typeof sidequestKinds)[keyof typeof sidequestKinds]

/** Standard kinds Sidequest reads: profile metadata (NIP-01), relay lists (NIP-65, NIP-17) and listings (NIP-99). */
export const standardKinds = {
  profile: 0,
  relayList: 10_002,
  messagingRelays: 10_050,
  listing: 30_402,
  draftListing: 30_403,
} as const

/** The vocabulary version every Sidequest event carries as `["sq", "2"]`. */
export const vocabularyVersion = '2'

/** The envelope's tag names: the vocabulary version, the CAIP-2 network money moves on, and an agent's grant. */
export const envelopeTag = { version: 'sq', network: 'sq-net', grant: 'sq-grant' } as const
