import * as Domain from '@alchemy.run/domain'

/** No account or agent is registered under the id the caller sent. */
export class NotRegistered extends Domain.Rejection('NotRegistered') {}
