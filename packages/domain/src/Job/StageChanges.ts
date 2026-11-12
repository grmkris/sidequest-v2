import type { JobStage } from './WrongState.rejection.ts'

type Stage = typeof JobStage.Type

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
  DeliveryRejected: to('Disputed'),
  JobSettled: to('Settled'),
}
