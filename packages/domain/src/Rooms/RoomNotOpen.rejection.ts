import * as Domain from '@alchemy.run/domain'
import { RoomId } from '@sidequest/protocol'

/** Nothing opened this room yet: no proposal or award has reached it. */
export class RoomNotOpen extends Domain.Rejection('RoomNotOpen', { room: RoomId }) {}
