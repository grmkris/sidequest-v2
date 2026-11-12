import * as Domain from '@alchemy.run/domain'
import { JobState } from '@sidequest/protocol'
import { Schema } from 'effect'

/** A job's stage, including before its request was posted. */
export const JobStage = Schema.Union([Schema.Literal('Unposted'), JobState])

/** The job is not in a stage this command applies to. */
export class WrongState extends Domain.Rejection('WrongState', {
  state: JobStage,
  expected: Schema.Array(JobStage),
}) {}
