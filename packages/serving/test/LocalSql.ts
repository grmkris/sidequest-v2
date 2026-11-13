import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { Effect, Layer, Predicate, Stream } from 'effect'
import * as Reactivity from 'effect/reactivity/Reactivity'
import * as SqlClient from 'effect/sql/SqlClient'
import type { Connection } from 'effect/sql/SqlConnection'
import { SqlError, UnknownError } from 'effect/sql/SqlError'
import * as Statement from 'effect/sql/Statement'

// D1 for unit tests: SQLite in memory with every migration applied, behind Effect's SqlClient with the SQLite
// compiler that `@effect/sql-d1` uses. Real SQL semantics, no Worker; the native suite is what proves workerd's D1.
// Like D1, it offers no transactions, so a store cannot come to rely on one. Each Worker's tests pass the directory of
// their own database's migrations: the core's and the agent gateway's databases are separate.

/** The migration files in the order Alchemy applies them: by their number. */
const migrationFiles = (migrations: URL) =>
  readdirSync(migrations)
    .filter((name) => name.endsWith('.sql'))
    .toSorted()

const refused = (cause: unknown, operation: string) =>
  new SqlError({ reason: new UnknownError({ cause, message: 'SQLite refused the statement', operation }) })

const toInput = (value: unknown): Effect.Effect<SQLInputValue, SqlError> => {
  if (value === null || value === undefined) return Effect.succeed(null)
  if (Predicate.isBoolean(value)) return Effect.succeed(value ? 1 : 0)
  if (Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBigInt(value)) return Effect.succeed(value)
  if (value instanceof Uint8Array) return Effect.succeed(value)
  return Effect.fail(refused(`a parameter SQLite cannot bind: ${typeof value}`, 'bind'))
}

const connectionTo = (db: DatabaseSync): Connection => {
  const rows = (sql: string, params: ReadonlyArray<unknown>) =>
    Effect.flatMap(Effect.forEach(params, toInput), (values) =>
      Effect.try({ try: () => db.prepare(sql).all(...values), catch: (cause) => refused(cause, 'execute') }),
    )
  const transformed = (
    sql: string,
    params: ReadonlyArray<unknown>,
    transformRows: (<A extends object>(rows: ReadonlyArray<A>) => ReadonlyArray<A>) | undefined,
  ) => Effect.map(rows(sql, params), (result) => (transformRows === undefined ? result : transformRows(result)))
  const values = (sql: string, params: ReadonlyArray<unknown>) =>
    Effect.map(rows(sql, params), (result) => result.map((row) => Object.values(row)))
  return {
    execute: transformed,
    executeUnprepared: transformed,
    executeRaw: rows,
    executeValues: values,
    executeValuesUnprepared: values,
    executeStream: (sql, params, transformRows) =>
      Stream.unwrap(Effect.map(transformed(sql, params, transformRows), (result) => Stream.fromIterable(result))),
  }
}

/**
 * A fresh database with the schema the migrations in `migrations` (a directory URL) make, as `SqlClient`; `sqlite`
 * reads it directly.
 */
export const localSqlOf = (migrations: URL) => {
  const sqlite = new DatabaseSync(':memory:')
  for (const file of migrationFiles(migrations)) sqlite.exec(readFileSync(new URL(file, migrations), 'utf8'))
  const connection = connectionTo(sqlite)
  const layer = Layer.effect(
    SqlClient.SqlClient,
    SqlClient.make({
      driver: 'sqlite',
      acquirer: Effect.succeed(connection),
      compiler: Statement.makeCompilerSqlite(),
      transactionAcquirer: Effect.die('D1 offers no transactions'),
      spanAttributes: [],
    }),
  ).pipe(Layer.provide(Reactivity.layer))
  return { sqlite, layer }
}
