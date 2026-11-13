import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import { EscrowApi } from './EscrowGroup.ts'
import { EventsApi } from './EventsGroup.ts'
import { Status } from './Status.ts'

export class SystemApi extends HttpApiGroup.make('system').add(
  HttpApiEndpoint.get('status', '/api/status', { success: Status }),
) {}

/**
 * Sidequest's HTTP API: the status, the index over signed Nostr events ({@link EventsApi}) and the escrow
 * ({@link EscrowApi}). The index's jobs are added beside it, with the fold (`@sidequest/fold/api`).
 *
 * No endpoint reads anything a browser attaches by itself: there is no cookie, no session and no other ambient
 * credential. What changes state carries its own authority: `POST /api/events` a Nostr signature over the event, each
 * escrow POST a wallet signature the contract verifies, and the ruling a NIP-98 authorization by the arbitration key.
 * So every endpoint may be called from any origin, and a page on another site that makes a browser send one achieves
 * only what the signer could by sending it themselves; there is no same-origin rule to keep.
 *
 * The API sends no CORS headers. Its clients are Sidequest's own website (same origin) and servers such as the agent
 * gateway, which call it server-side and need none; a browser page on another origin can send the simple requests a
 * form can, but cannot read the answers or send JSON, which needs a preflight the API does not grant. Granting CORS to
 * third-party web clients is a later decision, not an oversight.
 */
export class SidequestApi extends HttpApi.make('sidequest').add(SystemApi, EventsApi, EscrowApi) {}
