import * as Domain from '@alchemy.run/domain'

/** Foundation model. Product aggregates arrive in later feature-port slices. */
export class Sidequest extends Domain.Model('Sidequest', { aggregates: [] }) {}
