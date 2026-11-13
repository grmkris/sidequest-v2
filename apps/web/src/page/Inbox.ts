import { maxKeyJobs } from '@sidequest/protocol'
import { Array, Effect, Option, Schema } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { AsyncData, Command, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'
import { SidequestClient } from '../Api.ts'
import { Language } from '../Language.ts'
import { Marks } from '../Marks.ts'
import { Me, pubkeyOf } from '../Me.ts'
import { defineReadNames, Names, unnamed, withNames } from '../Names.ts'
import { failedWith, Problem } from '../Problem.ts'
import { Rooms, UnreadOnJob } from '../Rooms.ts'
import { InboxJob, itemsOf } from './InboxItems.ts'

// The inbox (ROADMAP slice 15): what needs the person's key, computed in their browser. The index answers the jobs the
// key wrote a request or a proposal for (`GET /api/people/:pubkey/jobs`, at most 25) and each job folded; the browser
// keeps which items the person marked read and counts unseen room messages from its own room store. The server renders
// nothing personal: it does not know who the visitor is.

// MODEL

const JobsData = AsyncData.Schema(Schema.Array(InboxJob), Problem)

export const Model = Schema.Struct({
  language: Language,
  me: Me,
  /** The key the inbox was read for; a new signer reads it again. */
  maybeReadFor: Schema.Option(Schema.String),
  jobs: JobsData.schema,
  unread: Schema.Array(UnreadOnJob),
  seen: Schema.Array(Schema.String),
  names: Names,
  askedNames: Schema.Array(Schema.String),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  SucceededReadInbox: { pubkey: Schema.String, jobs: Schema.Array(InboxJob) },
  FailedReadInbox: { pubkey: Schema.String, problem: Problem },
  CompletedReadUnread: { pubkey: Schema.String, unread: Schema.Array(UnreadOnJob) },
  CompletedReadSeen: { pubkey: Schema.String, seen: Schema.Array(Schema.String) },
  ClickedRefresh: {},
  ClickedMarkAllRead: {},
  CompletedMarkSeen: {},
  SucceededReadNames: { names: Names },
  FailedReadNames: { problem: Problem },
})
export type Message = typeof Message.Type

// COMMAND

/** How many jobs are read at once. */
const jobReads = 4

/** The key's jobs, newest first, each as the index folds it now; a job the index no longer has is left out. */
export const ReadInbox = Command.define('ReadInbox', {
  args: { pubkey: Schema.String },
  messages: [Message.SucceededReadInbox, Message.FailedReadInbox],
  execute: ({ pubkey }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const fresh = Effect.provideService(FetchHttpClient.RequestInit, { cache: 'no-cache' })
      const { items } = yield* api.events.personJobs({ params: { pubkey } }).pipe(fresh)
      const read = yield* Effect.forEach(
        Array.take(items, maxKeyJobs),
        ({ job, role }) =>
          api.indexJobs.job({ params: { id: job } }).pipe(
            fresh,
            Effect.map((view) => Option.some({ role, view })),
            Effect.catchTag('NotIndexed', () => Effect.succeed(Option.none())),
          ),
        { concurrency: jobReads },
      )
      return Message.SucceededReadInbox({ pubkey, jobs: Array.getSomes(read) })
    }).pipe(Effect.catch(failedWith((payload) => Message.FailedReadInbox({ pubkey, ...payload })))),
})

/** The unseen room messages per job, from this browser's room store; none when it holds nothing or cannot be read. */
export const ReadUnread = Command.define('ReadUnread', {
  args: { pubkey: Schema.String },
  messages: [Message.CompletedReadUnread],
  execute: ({ pubkey }) =>
    Rooms.use((rooms) => rooms.unread(pubkey)).pipe(
      Effect.orElseSucceed((): ReadonlyArray<UnreadOnJob> => []),
      Effect.map((unread) => Message.CompletedReadUnread({ pubkey, unread })),
    ),
})

/** The items the person marked read in this browser. */
export const ReadSeen = Command.define('ReadSeen', {
  args: { pubkey: Schema.String },
  messages: [Message.CompletedReadSeen],
  execute: ({ pubkey }) =>
    Marks.use((marks) => marks.seen(pubkey)).pipe(Effect.map((seen) => Message.CompletedReadSeen({ pubkey, seen }))),
})

export const MarkSeen = Command.define('MarkSeen', {
  args: { pubkey: Schema.String, keys: Schema.Array(Schema.String) },
  messages: [Message.CompletedMarkSeen],
  execute: ({ pubkey, keys }) =>
    Marks.use((marks) => marks.markSeen(pubkey, keys)).pipe(Effect.as(Message.CompletedMarkSeen())),
})

export const ReadNames = defineReadNames(Message.SucceededReadNames, Message.FailedReadNames)

// INIT

export type Services = SidequestClient | Rooms | Marks
type UpdateReturn = Update.Return<Model, Message, Services>

/** The reads of the inbox of `pubkey`. */
const readsFor = (model: Model, pubkey: string): UpdateReturn => ({
  model: modifyFields(model, {
    maybeReadFor: () => Option.some(pubkey),
    jobs: (jobs) => Option.getOrElse(AsyncData.revalidateOrLoad(jobs), () => jobs),
  }),
  commands: [ReadInbox({ pubkey }), ReadUnread({ pubkey }), ReadSeen({ pubkey })],
})

/** The inbox of the signer the site knows, once it knows one; the server renders it as being looked for. */
export const init = (language: Language, me: Me): UpdateReturn => {
  const model: Model = {
    language,
    me,
    maybeReadFor: Option.none(),
    jobs: AsyncData.Idle(),
    unread: [],
    seen: [],
    names: [],
    askedNames: [],
  }
  return Option.match(pubkeyOf(me), { onNone: () => ({ model }), onSome: (pubkey) => readsFor(model, pubkey) })
}

/** Who the person is changed: a new key's inbox is read; without a signer there is none to show. */
export const meChanged = (model: Model, me: Me): UpdateReturn => {
  const next = modifyFields(model, { me: () => me })
  return Option.match(pubkeyOf(me), {
    onNone: () => ({ model: next }),
    onSome: (pubkey) => (Option.contains(model.maybeReadFor, pubkey) ? { model: next } : readsFor(next, pubkey)),
  })
}

// UPDATE

/** An answer for the key the inbox is read for now; one for an earlier signer is dropped. */
const forCurrent = (model: Model, pubkey: string, apply: () => UpdateReturn): UpdateReturn =>
  Option.contains(model.maybeReadFor, pubkey) ? apply() : { model }

/** Every key the items name, whose names are asked for once. */
const peopleIn = (jobs: ReadonlyArray<InboxJob>): ReadonlyArray<string> =>
  Array.flatMap(jobs, ({ view }) => [view.buyer, ...Array.map(view.proposals, (proposal) => proposal.author)])

const inboxRead = (model: Model, jobs: ReadonlyArray<InboxJob>): UpdateReturn => {
  const next = modifyFields(model, { jobs: () => JobsData.Success({ data: jobs }) })
  return Array.match(unnamed(peopleIn(jobs), model.names, model.askedNames), {
    onEmpty: () => ({ model: next }),
    onNonEmpty: (pubkeys) => ({
      model: modifyFields(next, { askedNames: Array.appendAll(pubkeys) }),
      commands: [ReadNames({ pubkeys })],
    }),
  })
}

/** The keys of every item shown now. */
export const shownKeys = (model: Model): ReadonlyArray<string> =>
  Option.match(Option.all({ pubkey: pubkeyOf(model.me), jobs: AsyncData.getData(model.jobs) }), {
    onNone: () => [],
    onSome: ({ pubkey, jobs }) => Array.map(itemsOf(pubkey, jobs, model.unread), (item) => item.key),
  })

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    SucceededReadInbox: ({ pubkey, jobs }) => forCurrent(model, pubkey, () => inboxRead(model, jobs)),
    FailedReadInbox: ({ pubkey, problem }) =>
      forCurrent(model, pubkey, () => ({
        model: modifyFields(model, { jobs: () => JobsData.Failure({ error: problem }) }),
      })),
    CompletedReadUnread: ({ pubkey, unread }) =>
      forCurrent(model, pubkey, () => ({ model: modifyFields(model, { unread: () => unread }) })),
    CompletedReadSeen: ({ pubkey, seen }) =>
      forCurrent(model, pubkey, () => ({ model: modifyFields(model, { seen: () => seen }) })),
    ClickedRefresh: () =>
      Option.match(pubkeyOf(model.me), { onNone: () => ({ model }), onSome: (pubkey) => readsFor(model, pubkey) }),
    ClickedMarkAllRead: () =>
      Option.match(pubkeyOf(model.me), {
        onNone: () => ({ model }),
        onSome: (pubkey) => {
          const keys = shownKeys(model)
          return {
            model: modifyFields(model, { seen: (seen) => Array.dedupe(Array.appendAll(seen, keys)) }),
            commands: [MarkSeen({ pubkey, keys })],
          }
        },
      }),
    CompletedMarkSeen: () => ({ model }),
    SucceededReadNames: ({ names }) => ({ model: modifyFields(model, { names: (known) => withNames(known, names) }) }),
    FailedReadNames: () => ({ model }),
  })
