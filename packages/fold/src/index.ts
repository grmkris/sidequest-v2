// The job as a pure fold over its signed Nostr events, the chain's facts about its escrow and the verified wallet
// links (ADR-0003): no I/O, no clock, no randomness, browser-safe. The server index and the website run the same fold.
export {
  ChainDelivered,
  ChainEnding,
  ChainFact,
  ChainFunded,
  ChainReclaimed,
  ChainRejected,
  ChainSettled,
  LogPosition,
  OperatorOutcome,
} from './ChainFacts.ts'
export { foldJob, foldJobs } from './FoldJob.ts'
export type { FoldContext, JobEvent, JobInput, WalletLinkFact } from './JobInput.ts'
export {
  AcceptView,
  Deadlines,
  DeliveryNoteView,
  FundingView,
  JobView,
  ProposalView,
  RequestView,
  ReviewSide,
  ReviewView,
  Stage,
  StatementView,
} from './JobView.ts'
