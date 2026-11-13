import { actingOf, type GrantRefusal, grantsById, principalOf } from '@sidequest/fold'
import type { NostrEvent } from '@sidequest/nostr'
import {
  envelopeTag,
  jobProposal,
  type JobProposalContent,
  jobRequest,
  type JobRequestContent,
  type KindSpec,
  type ParsedEvent,
  parseSidequestEvent,
  sidequestKinds,
  statement,
} from '@sidequest/nostr/vocabulary'
import type { Unavailable } from '@sidequest/protocol'
import { Effect, Option, Predicate } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'
import { Schema } from 'effect'
import { stored } from '@sidequest/serving/Stored'
import { ChainFacts } from '../Index/ChainFacts.ts'
import { EventRow, EventStore } from '../Index/EventStore.ts'
import { grantsNamedBy } from '../Index/JobGrants.ts'

/** Everything the funding rules judge, read from the index: see `FundingRules.ts`. */
export interface Standing {
  readonly request: Option.Option<ParsedEvent<JobRequestContent>>
  readonly proposal: Option.Option<ParsedEvent<JobProposalContent>>
  /**
   * Why the grant the proposal names does not make it its operator's (the fold's `GrantRefusal`); `null` when it names
   * none, or its grant authorises it and the bidder is that operator.
   */
  readonly bidderGrant: GrantRefusal | null
  /** The proposal's bidder: its author, or the operator whose grant let the agent that signed it propose. */
  readonly bidder: Option.Option<string>
  /** The proposal's bidder (its author, or the operator whose agent made it) withdrew it, themselves or by an agent. */
  readonly withdrawn: boolean
  /** A proposal by the same bidder names it as `previous`. */
  readonly superseded: boolean
  /** The key the payer's wallet is currently linked to by a verified link, if any. */
  readonly payerHolder: Option.Option<string>
  /** The chain's facts hold a `JobFunded` for the job. */
  readonly fundedOnChain: boolean
}

/** The most statements and revisions read about one proposal; an author signs a handful. */
const aboutLimit = 20

/** The event, verified and read as `spec`'s kind, or nothing when it is missing or no longer reads. */
const parsedAs = <C>(spec: KindSpec<C>, event: Option.Option<NostrEvent>) =>
  Option.match(event, {
    onNone: () => Effect.succeedNone,
    onSome: (found) => Effect.option(parseSidequestEvent(spec, found)),
  })

/**
 * What the index says of a proposal for a job and of a payer, for the funding rules. Every event is verified again
 * as it is read, and judged against the grants it names, as the fold does: the bidder is the proposal's author, or the
 * operator whose grant authorised the agent that signed it. The bidder's statements and revisions (by their own key,
 * the proposal's signing key, or a key naming a grant the bidder gave) are found through their `e` tag on the proposal
 * (a statement's `about` and a revision's `previous` are tagged), so many proposals on the job hide nothing.
 */
export const standingReads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const events = yield* EventStore
  const facts = yield* ChainFacts
  const Asked = Schema.Struct({ id: Schema.String, kind: Schema.Int, author: Schema.String, bidder: Schema.String })
  const about = SqlSchema.findAll({
    Request: Asked,
    Result: EventRow,
    execute: ({ id, kind, author, bidder }) => sql`
      SELECT id, pubkey, created_at, kind, tags, content, sig FROM events
      WHERE id IN (SELECT event_id FROM event_tags WHERE name = 'e' AND value = ${id})
        AND +kind = ${kind} AND (pubkey IN (${author}, ${bidder}) OR id IN (
          SELECT t.event_id FROM event_tags AS t JOIN agent_grants AS g ON g.event_id = t.value
          WHERE t.name = ${envelopeTag.grant} AND g.operator = ${bidder}))
      ORDER BY created_at DESC, id LIMIT ${aboutLimit}`,
  })

  /** The bidder's events of `spec`'s kind about the proposal, each read and counted only if it is the bidder's. */
  const bidders = <C>(spec: KindSpec<C>, proposal: ParsedEvent<JobProposalContent>, bidder: string) =>
    Effect.gen(function* () {
      const rows = yield* stored(
        about({ id: proposal.event.id, kind: spec.kind, author: proposal.event.pubkey, bidder }),
      )
      const grants = grantsById(yield* grantsNamedBy(events, rows))
      const read = (yield* Effect.forEach(rows, (row) => parsedAs(spec, Option.some(row)))).flatMap(Option.toArray)
      // A withdrawal or a revision needs the `propose` scope, as the proposal does.
      return read.filter((parsed) => principalOf(actingOf(parsed, 'propose', grants), parsed) === bidder)
    })

  const labels = Effect.fnUntraced(function* (proposal: ParsedEvent<JobProposalContent>) {
    const acting = actingOf(proposal, 'propose', grantsById(yield* grantsNamedBy(events, [proposal.event])))
    const bidder = principalOf(acting, proposal)
    const statements = yield* bidders(statement, proposal, bidder)
    const revisions = yield* bidders(jobProposal, proposal, bidder)
    return {
      bidderGrant: acting.grantRefusal,
      bidder: Option.some(bidder),
      withdrawn: statements.some(
        ({ content }) => content.type === 'withdraw_proposal' && content.about === proposal.event.id,
      ),
      superseded: revisions.some(({ content }) => content.previous === proposal.event.id),
    }
  })

  return Effect.fn('Sidequest.Escrow.standing')(function* (
    job: string,
    proposalId: string,
    payerAccount: string,
  ): Effect.fn.Return<Standing, Unavailable> {
    const request = yield* parsedAs(jobRequest, yield* events.find(job))
    const proposal = Option.filter(
      yield* parsedAs(jobProposal, yield* events.find(proposalId)),
      ({ content }) => content.job === job,
    )
    const label = Option.isSome(proposal)
      ? yield* labels(proposal.value)
      : { bidderGrant: null, bidder: Option.none(), withdrawn: false, superseded: false }
    const holder = Option.map(yield* events.wallet(payerAccount), ({ pubkey }) => pubkey)
    const chain = yield* facts.forJob(job)
    return {
      request,
      proposal,
      ...label,
      payerHolder: holder,
      fundedOnChain: chain.some((fact) => Predicate.isTagged(fact, 'Funded')),
    }
  })
})

/** The request event of a job, verified, if the index holds it: what makes a job one the escrow serves. */
export const requestOf = (events: EventStore['Service'], job: string) =>
  Effect.flatMap(events.find(job), (found) =>
    parsedAs(
      jobRequest,
      Option.filter(found, (event) => event.kind === sidequestKinds.request),
    ),
  )
