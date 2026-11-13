import { Schema } from 'effect'
import { AccountRef } from './AccountRef.ts'
import { Bytes32 } from './Bytes32.ts'
import { SignedEvent } from './EventsApi.ts'
import { Hex32 } from './Hex32.ts'
import { WalletAddress } from './Wallet.ts'

// ERC-8004 ("Trustless Agents", ethereum/ERCs 503591a, Draft) as Sidequest serves it (ADR-0007): the agent
// registration file an identity's `agentURI` resolves to, the off-chain feedback file of a key's counted reviews, and
// the identities the index verified. The specification's own shapes are kept loose (`Erc8004RegistrationFile`,
// `Erc8004Feedback`) and are checked against its examples; what Sidequest serves is those shapes and more.

/** The registration file's `type`: version 1 of ERC-8004's agent registration file. */
export const erc8004RegistrationType = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1'

/** A non-negative integer JSON can carry exactly: an `agentId` as the specification's examples spell it. */
const AgentIdNumber = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))

/** One service a registration file advertises (`MCP`, `A2A`, `ENS`, …), its endpoint and, as it SHOULD, a version. */
export const Erc8004Service = Schema.Struct({
  name: Schema.String,
  endpoint: Schema.String,
  version: Schema.optionalKey(Schema.String),
})
export type Erc8004Service = typeof Erc8004Service.Type

/** One registration: the token on a registry, `{namespace}:{chainId}:{identityRegistry}`. Both are mandatory. */
export const Erc8004Registration = Schema.Struct({ agentId: AgentIdNumber, agentRegistry: Schema.String })
export type Erc8004Registration = typeof Erc8004Registration.Type

/** The agent registration file as the specification defines it; other fields are allowed, and ignored here. */
export const Erc8004RegistrationFile = Schema.Struct({
  type: Schema.Literal(erc8004RegistrationType),
  name: Schema.String,
  description: Schema.String,
  image: Schema.optionalKey(Schema.String),
  services: Schema.Array(Erc8004Service),
  x402Support: Schema.Boolean,
  active: Schema.Boolean,
  registrations: Schema.Array(Erc8004Registration),
  supportedTrust: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type Erc8004RegistrationFile = typeof Erc8004RegistrationFile.Type

/**
 * What Sidequest says about the key beside the specification's fields: the key, the operator whose grant lets it act
 * and that grant (both absent for a person registered as themselves), and where its feedback file is.
 */
export const SidequestRegistrationFacts = Schema.Struct({
  pubkey: Hex32,
  operator: Schema.optionalKey(Hex32),
  grant: Schema.optionalKey(Hex32),
  feedback: Schema.String,
})

/** The registration file Sidequest serves for a key: the specification's, with `sidequest` beside it. */
export const SidequestRegistrationFile = Schema.Struct({
  ...Erc8004RegistrationFile.fields,
  sidequest: SidequestRegistrationFacts,
})
export type SidequestRegistrationFile = typeof SidequestRegistrationFile.Type

/** A payment the feedback is about: who paid whom on which chain, in which transaction (the spec's x402 example). */
export const Erc8004ProofOfPayment = Schema.Struct({
  fromAddress: Schema.String,
  toAddress: Schema.String,
  chainId: Schema.String,
  txHash: Schema.String,
})

/** The off-chain feedback file of one piece of feedback, as the specification defines its fields. */
export const Erc8004Feedback = Schema.Struct({
  agentRegistry: Schema.String,
  agentId: AgentIdNumber,
  clientAddress: Schema.String,
  createdAt: Schema.String,
  value: Schema.Number,
  valueDecimals: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 18 })),
  tag1: Schema.optionalKey(Schema.String),
  tag2: Schema.optionalKey(Schema.String),
  endpoint: Schema.optionalKey(Schema.String),
  proofOfPayment: Schema.optionalKey(Erc8004ProofOfPayment),
})

/**
 * Sidequest's evidence for one feedback entry: the job, the operator contract whose logs prove it, the escrow's funding
 * and settlement transactions, the signed review, the wallet links that tie the reviewer and the subject to the
 * escrow's two sides, and, for an agent, the funded proposal it signed and the grant it signed it under.
 */
export const SidequestFeedbackEvidence = Schema.Struct({
  job: Hex32,
  operator: AccountRef,
  fundingTx: Bytes32,
  settlementTx: Bytes32,
  review: SignedEvent,
  reviewerLink: SignedEvent,
  subjectLink: SignedEvent,
  proposal: Schema.optionalKey(SignedEvent),
  grant: Schema.optionalKey(SignedEvent),
})
export type SidequestFeedbackEvidence = typeof SidequestFeedbackEvidence.Type

/**
 * One counted review as ERC-8004 feedback: the specification's fields (the registry and `agentId` only once the key
 * has a verified identity; the client is the reviewer's side of the escrow; the rating times 20 as `starred`'s 0–100,
 * `tag2` `sidequest`; the funding as the proof of payment) and Sidequest's evidence.
 */
export const SidequestFeedbackEntry = Schema.Struct({
  agentRegistry: Schema.optionalKey(Schema.String),
  agentId: Schema.optionalKey(AgentIdNumber),
  clientAddress: AccountRef,
  createdAt: Schema.String,
  value: Schema.Int,
  valueDecimals: Schema.Literal(0),
  tag1: Schema.Literal('starred'),
  tag2: Schema.Literal('sidequest'),
  proofOfPayment: Erc8004ProofOfPayment,
  sidequest: SidequestFeedbackEvidence,
})
export type SidequestFeedbackEntry = typeof SidequestFeedbackEntry.Type

/**
 * An entry with where it is served alone and that document's `keccak256`: the `feedbackURI` and `feedbackHash` to post
 * with it on chain. The document is the entry's RFC 8785 canonical JSON.
 */
export const SidequestFeedbackItem = Schema.Struct({
  feedbackURI: Schema.String,
  feedbackHash: Bytes32,
  entry: SidequestFeedbackEntry,
})
export type SidequestFeedbackItem = typeof SidequestFeedbackItem.Type

/** A key's feedback file: its verified registrations, its counted reviews' number and mean rating, and the entries. */
export const SidequestFeedbackFile = Schema.Struct({
  subject: Hex32,
  registrations: Schema.Array(Erc8004Registration),
  count: Schema.Int,
  averageRating: Schema.NullOr(Schema.Number),
  items: Schema.Array(SidequestFeedbackItem),
})
export type SidequestFeedbackFile = typeof SidequestFeedbackFile.Type

/** The stage's ERC-8004 registries, on its settlement chain; each `null` when the stage has none. */
export const Erc8004Deployment = Schema.Struct({
  chainId: Schema.NullOr(Schema.Int),
  identityRegistry: Schema.NullOr(AccountRef),
  reputationRegistry: Schema.NullOr(AccountRef),
})
export type Erc8004Deployment = typeof Erc8004Deployment.Type

/** A transaction a wallet sends itself: on `chainId`, to `to`, with calldata `data`. */
export const Erc8004Transaction = Schema.Struct({
  chainId: Schema.Int,
  to: WalletAddress,
  data: Schema.String.check(Schema.isPattern(/^0x(?:[0-9a-f]{2})*$/u)),
})
export type Erc8004Transaction = typeof Erc8004Transaction.Type

/** `register(agentURI)` for a key's registration file, at this origin. */
export const Erc8004RegistrationCall = Schema.Struct({ ...Erc8004Transaction.fields, agentURI: Schema.String })
export type Erc8004RegistrationCall = typeof Erc8004RegistrationCall.Type

/** `giveFeedback` of one entry, which only its client's wallet (`from`) should send: the registry refuses the owner. */
export const Erc8004FeedbackCall = Schema.Struct({ ...Erc8004Transaction.fields, from: WalletAddress })
export type Erc8004FeedbackCall = typeof Erc8004FeedbackCall.Type
