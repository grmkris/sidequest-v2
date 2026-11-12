import type { JobStage } from '@sidequest/protocol'

type Stage = JobStage

const to =
  (stage: Stage) =>
  <View extends { readonly state: Stage }>(view: View): View => ({ ...view, state: stage })

/** How a view of a job follows its stage after it was posted: one handler per event that moves it. */
export const stageChanges = {
  ProposalAccepted: to('Awarded'),
  RequestCancelled: to('Cancelled'),
  RequestExpired: to('Expired'),
  FundingRecorded: to('Funded'),
  DeliveryRecorded: to('Delivered'),
  RejectionRecorded: to('Disputed'),
  JobSettled: to('Settled'),
}
