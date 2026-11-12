import * as Domain from '@alchemy.run/domain'
import { Actor } from './Actor.ts'

/**
 * Who sent the current command. `Session` provides it to commands from people and agents; policies and the
 * settlement saga provide the system actor themselves. Every `decide` authorizes against it.
 */
export class CurrentActor extends Domain.RequestContext<CurrentActor>()('Sidequest/CurrentActor', Actor) {}
