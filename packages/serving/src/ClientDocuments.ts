import { Array, Context, Duration, Effect, Layer, Option, Schema, Stream } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpClient from 'effect/http/HttpClient'
import { isAcceptableRedirect } from './RedirectUris.ts'

/** The largest client metadata document read; the CIMD draft suggests 5 KB. */
const maxDocumentBytes = 5 * 1024

/** How long the client's host has to answer. */
const fetchTimeoutMs = 5000

/** A document longer than this server reads. */
class TooLong extends Schema.TaggedError<TooLong>()('TooLong', {}) {}

/** A response body as text, if it is at most {@link maxDocumentBytes} long. */
const cappedText = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  Stream.runFoldEffect(
    stream,
    () => ({ size: 0, chunks: Array.empty<Uint8Array>() }),
    ({ size, chunks }, chunk) =>
      size + chunk.byteLength > maxDocumentBytes
        ? Effect.fail(new TooLong())
        : Effect.succeed({ size: size + chunk.byteLength, chunks: [...chunks, chunk] }),
  ).pipe(
    Effect.map(({ size, chunks }) => {
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return new TextDecoder().decode(bytes)
    }),
  )

/**
 * Fetches client metadata documents (CIMD) from the hosts that publish them. A document is answered only from a
 * `200` to a plain GET, without following a redirect (the document must live at its own URL), within five seconds
 * and five kilobytes; anything else answers nothing. A Worker's `fetch` reaches the public internet only, so the URL
 * cannot reach anything private; the URL is still checked first ({@link isDocumentUrl}).
 */
export class ClientDocuments extends Context.Service<
  ClientDocuments,
  { readonly fetch: (url: string) => Effect.Effect<Option.Option<string>> }
>()('Sidequest/ClientDocuments') {
  static readonly layer = Layer.effect(
    ClientDocuments,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return {
        fetch: (url: string) =>
          client.get(url, { headers: { accept: 'application/json' } }).pipe(
            Effect.flatMap((response) =>
              response.status === 200 ? Effect.map(cappedText(response.stream), Option.some) : Effect.succeedNone,
            ),
            Effect.timeout(Duration.millis(fetchTimeoutMs)),
            Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'manual' }),
            Effect.orElseSucceed(() => Option.none<string>()),
          ),
      }
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer))
}

/** A client's metadata document, with the fields this server reads (draft-ietf-oauth-client-id-metadata-document). */
const Document = Schema.Struct({
  client_id: Schema.String,
  client_name: Schema.optional(Schema.String),
  redirect_uris: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
})
const decodeDocument = Schema.decodeUnknownOption(Schema.fromJsonString(Document))

/**
 * Whether `id` can be a client id metadata document's URL: HTTPS with a path (MCP authorization, client registration),
 * a host name rather than an address or `localhost`, no credentials, no fragment.
 */
export const isDocumentUrl = (id: string): boolean => {
  if (id.length > 2000 || !URL.canParse(id)) return false
  const url = new URL(id)
  return (
    url.protocol === 'https:' &&
    url.pathname !== '/' &&
    url.hash === '' &&
    url.username === '' &&
    url.password === '' &&
    url.hostname !== 'localhost' &&
    !/^[\d.]+$/u.test(url.hostname) &&
    !url.hostname.startsWith('[')
  )
}

/** A client as authorization knows it: who it says it is, who vouches for that, and where it may be sent. */
export interface KnownClient {
  readonly id: string
  readonly name: string | null
  readonly kind: 'registered' | 'published'
  readonly publisher: string | null
  readonly redirectUris: ReadonlyArray<string>
}

/** The longest client name shown; longer ones are cut. Control characters are dropped. */
export const clientName = (name: string | undefined) => {
  const shown = (name ?? '')
    .replace(/\p{Cc}/gu, '')
    .trim()
    .slice(0, 100)
  return shown === '' ? null : shown
}

/**
 * The client a metadata document URL names, from the document its host publishes there: it must name itself by that
 * exact URL, and only the redirects this server accepts are kept. Anything else is no client.
 */
export const publishedClient = Effect.fn('Sidequest.OAuth.publishedClient')(function* (
  documents: ClientDocuments['Service'],
  id: string,
) {
  if (!isDocumentUrl(id)) return Option.none<KnownClient>()
  const fetched = yield* documents.fetch(id)
  return Option.flatMap(Option.flatMap(fetched, decodeDocument), (document): Option.Option<KnownClient> => {
    const redirectUris = document.redirect_uris.filter(isAcceptableRedirect)
    if (document.client_id !== id || redirectUris.length === 0) return Option.none()
    const name = clientName(document.client_name)
    return Option.some({ id, name, kind: 'published', publisher: new URL(id).host, redirectUris })
  })
})
