import { WorkRequest } from '@sidequest/protocol'
import { Context, Effect, Layer, Predicate, Schema } from 'effect'
import { RowVersion, versionedRows } from '../VersionedRows.ts'

/** An open request, as the list of open jobs shows it. `version` is the job stream's sequence number it reflects. */
export const OpenJobRow = Schema.Struct({
  id: WorkRequest.fields.id,
  buyer: WorkRequest.fields.buyer,
  title: WorkRequest.fields.title,
  expiresAt: WorkRequest.fields.expiresAt,
  version: RowVersion,
})
export type OpenJobRow = typeof OpenJobRow.Type

/** A request opened (with its row), or closed: awarded, cancelled or expired. */
export const OpenJobChange = Schema.Union([
  Schema.TaggedStruct('Opened', { row: OpenJobRow }),
  Schema.TaggedStruct('Closed', { id: WorkRequest.fields.id, version: RowVersion }),
])
export type OpenJobChange = typeof OpenJobChange.Type

/**
 * The port the `OpenJobs` projection writes through. `apply` must ignore a change whose version is not newer than
 * the one it holds for that job, a closed job's included, so redelivered changes are harmless. The server implements
 * it with D1.
 */
export class OpenJobStore extends Context.Service<
  OpenJobStore,
  {
    readonly apply: (changes: ReadonlyArray<OpenJobChange>) => Effect.Effect<void>
    readonly list: Effect.Effect<ReadonlyArray<OpenJobRow>>
  }
>()('Sidequest/OpenJobStore') {}

/** An open-jobs store in memory, for stories. */
export const memoryOpenJobStore = () => {
  const rows = versionedRows<OpenJobRow>()
  return OpenJobStore.of({
    apply: (changes) =>
      Effect.sync(() => {
        for (const change of changes)
          if (Predicate.isTagged(change, 'Opened')) rows.change(change.row.id, change.row.version, () => change.row)
          else rows.change(change.id, change.version, () => undefined)
      }),
    list: Effect.sync(() => rows.all()),
  })
}

export const MemoryOpenJobStore = Layer.sync(OpenJobStore, memoryOpenJobStore)
