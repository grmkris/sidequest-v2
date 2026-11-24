/** Replies, and the two ways a request ends early: `Refused` (the caller's fault) and `Unavailable` (ours). */
import { Data, Effect, Option } from 'effect'

/** A request the API answers with this status and a JSON problem. */
export class Refused extends Data.TaggedError('Refused')<{
  readonly status: number
  readonly error: string
  readonly detail?: string
}> {}

/** D1 or R2 failed under a request: the Worker answers 500. */
export class Unavailable extends Data.TaggedError('Unavailable')<{ readonly cause: unknown }> {}

export const refuse = (status: number, error: string, detail?: string) =>
  Effect.fail(new Refused(detail === undefined ? { status, error } : { status, error, detail }))

export const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new Unavailable({ cause }) })

/** A value that must decode: a row or a binding with another shape is our fault, not the caller's. */
export const mustDecode =
  <A>(decode: (input: unknown) => Option.Option<A>, what: string) =>
  (input: unknown) =>
    Option.match(decode(input), {
      onNone: () => Effect.fail(new Unavailable({ cause: `${what} has an unexpected shape` })),
      onSome: (value) => Effect.succeed(value),
    })

/** Sent with everything: no sniffing, no referrer (a share link's token is in the address), never indexed. */
export const guardHeaders: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
}

export const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { ...guardHeaders, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

export const problem = (failure: Refused): Response =>
  json(
    failure.detail === undefined ? { error: failure.error } : { error: failure.error, detail: failure.detail },
    failure.status,
  )

export const text = (body: string, status: number, contentType = 'text/plain; charset=utf-8'): Response =>
  new Response(body, {
    status,
    headers: { ...guardHeaders, 'content-type': contentType, 'cache-control': 'no-store' },
  })

export const notFound = (): Response => text('Not found.', 404)

export const redirect = (location: string): Response =>
  new Response(null, { status: 301, headers: { ...guardHeaders, location, 'cache-control': 'no-store' } })

/** The request's JSON body through `decode`; anything else is a 400 with `error`. */
export const bodyOf = <A>(request: Request, decode: (input: unknown) => Option.Option<A>, error: string) =>
  Effect.tryPromise({ try: (): Promise<unknown> => request.json(), catch: () => undefined }).pipe(
    Effect.option,
    Effect.flatMap((body) =>
      Option.match(Option.flatMap(body, decode), {
        onNone: () => refuse(400, error),
        onSome: (value) => Effect.succeed(value),
      }),
    ),
  )
