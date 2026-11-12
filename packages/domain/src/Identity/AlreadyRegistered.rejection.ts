import * as Domain from '@alchemy.run/domain'

/** This account or agent is registered already; the id the caller sent is the evidence. */
export class AlreadyRegistered extends Domain.Rejection('AlreadyRegistered') {}
