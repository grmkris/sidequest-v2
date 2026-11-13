// A NIP-01 relay client over the standard `WebSocket` (NIP-42 authentication included), for every host Sidequest runs
// in: the index, the agent gateway, and the browser through the edge's relay pipe.
export {
  type AuthSigner,
  type ClientOptions,
  connectRelay,
  keyAuth,
  type RelayConnection,
  RelayFailure,
} from './RelayClient.ts'
export type { Filter, OkReply } from './RelayFrames.ts'
