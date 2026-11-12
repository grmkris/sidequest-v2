import { AccountId, JobId, RoomId, UnixSeconds } from '@sidequest/protocol'
import { Context, Effect, Layer, Schema } from 'effect'

/** What happened that concerns the account. */
export const InboxKind = Schema.Literals([
  'proposal_submitted',
  'change_requested',
  'proposal_accepted',
  'funding_recorded',
  'delivery_recorded',
  'job_settled',
  'message_posted',
])
export type InboxKind = typeof InboxKind.Type

/**
 * One item in an account's inbox. `cursor` counts up per account, from 1, in the order the items reached it: a reader
 * asks for the items after the last cursor it saw. `id` is the source event's `stream:seq`, unique per account, so a
 * redelivered item overwrites itself.
 */
export const InboxItem = Schema.Struct({
  account: AccountId,
  cursor: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  id: Schema.String,
  kind: InboxKind,
  job: JobId,
  room: Schema.NullOr(RoomId),
  at: UnixSeconds,
})
export type InboxItem = typeof InboxItem.Type

/**
 * The port the `Inbox` projection writes through. `record` upserts by account and `id`, so redelivered items are
 * harmless. The server implements it with D1.
 */
export class InboxStore extends Context.Service<
  InboxStore,
  {
    readonly record: (items: ReadonlyArray<InboxItem>) => Effect.Effect<void>
    readonly list: (account: AccountId, after: number) => Effect.Effect<ReadonlyArray<InboxItem>>
  }
>()('Sidequest/InboxStore') {}

/** An inbox store in memory, for stories. */
export const memoryInboxStore = () => {
  const inboxes = new Map<AccountId, Map<string, InboxItem>>()
  return InboxStore.of({
    record: (items) =>
      Effect.sync(() => {
        for (const item of items) {
          const inbox = inboxes.get(item.account) ?? new Map<string, InboxItem>()
          inboxes.set(item.account, inbox.set(item.id, item))
        }
      }),
    list: (account, after) =>
      Effect.sync(() =>
        [...(inboxes.get(account)?.values() ?? [])]
          .filter((item) => item.cursor > after)
          .toSorted((a, b) => a.cursor - b.cursor),
      ),
  })
}

export const MemoryInboxStore = Layer.sync(InboxStore, memoryInboxStore)
