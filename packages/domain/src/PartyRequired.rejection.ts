import * as Domain from '@alchemy.run/domain'
import { Schema } from 'effect'

/** Only a person or their agent may send this; the system actor may not. */
export class PartyRequired extends Domain.Rejection('PartyRequired', { system: Schema.String }) {}
