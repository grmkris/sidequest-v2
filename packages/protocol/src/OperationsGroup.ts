import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import { Hex32 } from './Hex32.ts'
import { Unavailable } from './Refusals.ts'
import { HiddenTarget, HideRequest, ModerationRefused, SettlementHealth } from './Operations.ts'

/**
 * Running a stage in the open: the relayer's health, and the index's hide list, which anyone may read and only the
 * stage's moderator key changes (a NIP-98 authorization for exactly the request, as the ruling's). Hiding takes an
 * event, or every event of a key, out of the index's lists; reads by id still answer, with the `sidequest-labels:
 * hidden` header. Nothing is deleted: the events stay signed and on relays (docs/MAINNET-READINESS.md, "Moderation").
 */
export class OperationsApi extends HttpApiGroup.make('operations').add(
  HttpApiEndpoint.get('settlementHealth', '/api/status/settlement', {
    success: SettlementHealth,
    error: Unavailable,
  }),
  HttpApiEndpoint.get('hidden', '/api/moderation/hidden', {
    success: Schema.Struct({ items: Schema.Array(HiddenTarget) }),
    error: Unavailable,
  }),
  HttpApiEndpoint.put('hide', '/api/moderation/hidden/:target', {
    params: { target: Hex32 },
    payload: HideRequest,
    success: HiddenTarget,
    error: [ModerationRefused, Unavailable],
  }),
  HttpApiEndpoint.delete('unhide', '/api/moderation/hidden/:target', {
    params: { target: Hex32 },
    success: Schema.Struct({ target: Hex32 }),
    error: [ModerationRefused, Unavailable],
  }),
) {}
