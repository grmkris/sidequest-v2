// The job as a pure fold over its signed Nostr events, the chain's facts about its escrow, the verified wallet links
// and the agents' grants (ADR-0003): no I/O, no clock, no randomness, browser-safe. The server index and the website
// run the same fold.
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
export { type Acting, actingOf, GrantRefusal, grantsById, principalOf, scopeOf } from './Grants.ts'
export type { FoldContext, GrantFact, JobEvent, JobInput, WalletLinkFact } from './JobInput.ts'
export {
  AcceptView,
  Deadlines,
  DeliveryNoteView,
  FundingView,
  JobView,
  ProposalView,
  RequestView,
  settledStages,
  ReviewSide,
  ReviewView,
  Stage,
  StatementView,
} from './JobView.ts'
