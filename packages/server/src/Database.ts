import * as Cloudflare from '@alchemy.run/cloudflare'
import * as D1Client from '@effect/sql-d1/D1Client'
import { Effect, Layer } from 'effect'
import { SidequestDatabase } from './Resources.ts'

/**
 * The Worker's D1 database as Effect's `SqlClient`, over its binding: one client per runtime, shared by every store.
 * D1 runs each statement on its own and offers no transactions, so every write a store makes is one statement that
 * guards itself.
 */
export const SidequestSql = Layer.unwrap(
  Effect.gen(function* () {
    const database = yield* Cloudflare.D1.QueryDatabase(SidequestDatabase)
    return D1Client.layer({ db: yield* database.raw })
  }),
)
