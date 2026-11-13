/**
 * Sidequest's event kinds: one block, 8210–8220, in NIP-01's regular range and not in the NIPs' kind registry. They
 * live here alone so the block can move in one edit if a usage check on live relays finds it taken. One kind per
 * consequential action lets a NIP-46 signer scope an agent's key per action (`sign_event:<kind>`). 8217 and 8220 are
 * kept free.
 */
export const sidequestKinds = {
  walletLink: 8210,
  request: 8211,
  proposal: 8212,
  accept: 8213,
  deliveryNote: 8214,
  statement: 8215,
  review: 8216,
  grant: 8218,
  revocation: 8219,
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
