import * as Domain from '@alchemy.run/domain'
import { JobStage } from '@sidequest/protocol'
import { Schema } from 'effect'

/** The job is not in a stage this command applies to. */
export class WrongState extends Domain.Rejection('WrongState', {
  state: JobStage,
  expected: Schema.Array(JobStage),
}) {}
