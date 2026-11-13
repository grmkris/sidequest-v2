import { encodeNpub, PublicKey } from '@sidequest/nostr'
import { maxPeoplePerLookup, PersonName } from '@sidequest/protocol'
import { Array, Effect, Option, Schema } from 'effect'
import { Command } from 'foldkit'
import { SidequestClient } from './Api.ts'
import { failedWith, type Problem } from './Problem.ts'
import { shortHex } from './Text.ts'

// The names people go by. A person is their Nostr key; a page looks up every key it shows at once
// (`GET /api/people?pubkeys=`), and shows a key's short npub (NIP-19) while it has no profile name.

/** The names a page knows, as the index answered them. */
export const Names = Schema.Array(PersonName)
export type Names = typeof Names.Type

/** A key short enough to recognise: the start and end of its `npub`. The whole key stays in the element's title. */
export const shortNpub = (pubkey: string): string =>
  Option.match(Schema.decodeUnknownOption(PublicKey)(pubkey), {
    onNone: () => shortHex(pubkey),
    onSome: (key) => {
      const npub = encodeNpub(key)
      return `${npub.slice(0, 10)}…${npub.slice(-4)}`
    },
  })

const entryOf = (names: Names, pubkey: string) => Array.findFirst(names, (named) => named.pubkey === pubkey)

/** The name `pubkey` goes by, or its short npub while it has none. */
export const nameOf = (names: Names, pubkey: string): string =>
  Option.match(
    Option.flatMap(entryOf(names, pubkey), (named) => Option.fromNullishOr(named.name)),
    { onNone: () => shortNpub(pubkey), onSome: (name) => name },
  )

/** The keys among `pubkeys` neither known nor asked for already, each once, as one lookup takes them. */
export const unnamed = (
  pubkeys: ReadonlyArray<string>,
  names: Names,
  asked: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  Array.take(
    Array.filter(Array.dedupe(pubkeys), (pubkey) => !asked.includes(pubkey) && Option.isNone(entryOf(names, pubkey))),
    maxPeoplePerLookup,
  )

/** A page's `SucceededReadNames` Message: the names its lookup found. */
type NamesMessage<S> = Schema.Top & ((payload: { readonly names: Names }) => Schema.Schema.Type<S>)

/** A page's `FailedReadNames` Message: why its lookup failed. */
type NamesProblemMessage<F> = Schema.Top & ((payload: { readonly problem: Problem }) => Schema.Schema.Type<F>)

/** A page's `ReadNames` Command: look up the names of some keys in one request, answering with the page's own
 * Messages. */
export const defineReadNames = <S extends NamesMessage<S>, F extends NamesProblemMessage<F>>(
  succeeded: S,
  failed: F,
) => {
  const ReadNames = Command.define('ReadNames', {
    args: { pubkeys: Schema.NonEmptyArray(Schema.String) },
    messages: [succeeded, failed],
    execute: ({ pubkeys }) =>
      Effect.gen(function* () {
        const api = yield* (yield* SidequestClient).api
        const { people } = yield* api.events.people({ query: { pubkeys } })
        return succeeded({ names: people })
      }).pipe(Effect.catch(failedWith(failed))),
  })
  return ReadNames
}

/** Names learned now added to the ones known. */
export const withNames = (known: Names, learned: Names): Names =>
  Array.appendAll(
    Array.filter(known, (named) => !Array.some(learned, (fresh) => fresh.pubkey === named.pubkey)),
    learned,
  )
