// End-to-end encrypted rooms (ADR-0004): one `RoomTransport` interface, its NIP-17 implementation over ports the host
// supplies (relays, an inbox directory, a store and a signer), and disclosures for evidence. A separate entry, so a
// page that never opens a room never loads it.
export {
  DisclosureBundle,
  DisclosureRefused,
  disclosureScheme,
  discloseSeal,
  type VerifiedDisclosure,
  verifyDisclosure,
} from './Disclosure.ts'
export {
  defaultRoomOptions,
  type IdentityReport,
  makeNip17Rooms,
  type PollReport,
  type RoomOptions,
  type RoomPorts,
  RoomRefused,
  type RoomTransport,
  type SendReport,
} from './Nip17Rooms.ts'
export {
  foundingOf,
  maxTextLength,
  RoomAct,
  type RoomBody,
  RoomFounding,
  RoomMessage,
  RoomText,
} from './RoomMessage.ts'
export type { RelayPoll } from './RoomPoll.ts'
export {
  emptyRoomState,
  type InboxDirectory,
  type InboxFilter,
  type RelayAck,
  type RelayPort,
  RelayPortFailure,
  RoomId,
  RoomState,
  type RoomStore,
} from './RoomPorts.ts'
export { backdateSeconds, type Delivery } from './RoomSend.ts'
export { localRoomSigner, type RoomSigner, RoomSignerRefused } from './RoomSigner.ts'
export { compareMessages, type DropReason, type Membership, type Transcript, transcriptOf } from './RoomTranscript.ts'
