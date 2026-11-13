import type { NostrEvent } from '@sidequest/nostr'
import {
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
import { stored } from '../SignIn/Stored.ts'
import { ChainFacts } from '../Index/ChainFacts.ts'
import { EventRow, EventStore } from '../Index/EventStore.ts'

/** Everything the funding rules judge, read from the index: see `FundingRules.ts`. */
export interface Standing {
  readonly request: Option.Option<ParsedEvent<JobRequestContent>>
  readonly proposal: Option.Option<ParsedEvent<JobProposalContent>>
  /** The proposal's author signed a `withdraw_proposal` statement about it. */
  readonly withdrawn: boolean
  /** A proposal by the same author names it as `previous`. */
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
 * as it is read, as the fold does; the author's statements and revisions are found through their `e` tag on the
 * proposal (a statement's `about` and a revision's `previous` are tagged), so many proposals on the job hide nothing.
 */
export const standingReads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const events = yield* EventStore
  const facts = yield* ChainFacts
  const about = SqlSchema.findAll({
    Request: Schema.Struct({ id: Schema.String, kind: Schema.Int, author: Schema.String }),
    Result: EventRow,
    execute: ({ id, kind, author }) => sql`
      SELECT id, pubkey, created_at, kind, tags, content, sig FROM events
      WHERE id IN (SELECT event_id FROM event_tags WHERE name = 'e' AND value = ${id})
        AND kind = ${kind} AND pubkey = ${author}
      ORDER BY created_at DESC, id LIMIT ${aboutLimit}`,
  })

  const parsedAbout = <C>(spec: KindSpec<C>, proposal: ParsedEvent<JobProposalContent>) =>
    Effect.flatMap(stored(about({ id: proposal.event.id, kind: spec.kind, author: proposal.event.pubkey })), (rows) =>
      Effect.map(
        Effect.forEach(rows, (row) => parsedAs(spec, Option.some(row))),
        (read) => read.flatMap(Option.toArray),
      ),
    )

  const labels = Effect.fnUntraced(function* (proposal: ParsedEvent<JobProposalContent>) {
    const statements = yield* parsedAbout(statement, proposal)
    const revisions = yield* parsedAbout(jobProposal, proposal)
    return {
      withdrawn: statements.some(
        ({ content }) => content.type === 'withdraw_proposal' && content.about === proposal.event.id,
      ),
      superseded: revisions.some(({ content }) => content.previous === proposal.event.id),
    }
  })

  return Effect.fn('Sidequest.Native.standing')(function* (
    job: string,
    proposalId: string,
    payerAccount: string,
  ): Effect.fn.Return<Standing, Unavailable> {
    const request = yield* parsedAs(jobRequest, yield* events.find(job))
    const proposal = Option.filter(
      yield* parsedAs(jobProposal, yield* events.find(proposalId)),
      ({ content }) => content.job === job,
    )
    const label = Option.isSome(proposal) ? yield* labels(proposal.value) : { withdrawn: false, superseded: false }
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

/** The request event of a job, verified, if the index holds it: what makes a job Nostr-native. */
export const requestOf = (events: EventStore['Service'], job: string) =>
  Effect.flatMap(events.find(job), (found) =>
    parsedAs(
      jobRequest,
      Option.filter(found, (event) => event.kind === sidequestKinds.request),
    ),
  )
