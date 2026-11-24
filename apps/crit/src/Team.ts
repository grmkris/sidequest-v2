/**
 * The team's controls, behind Access like every private address: the buttons on the index post plain forms here.
 *
 * | Route                                      | Result                                               |
 * | ------------------------------------------ | ---------------------------------------------------- |
 * | `POST /_crit/pages/<slug>/visibility`      | `visibility=public|team`, then back to the index     |
 * | `POST /_crit/pages/<slug>/links`           | a new share link, shown once                         |
 * | `POST /_crit/pages/<slug>/links/revoke`    | every share link of the page stops working           |
 *
 * A member's Access session is ambient, so a form on another site could otherwise press these buttons for them: a
 * request must say it comes from this origin.
 */
import { Effect, Option, Schema } from 'effect'
import { changeVisibility, makeLink, revoke } from './Api.ts'
import type { Env } from './Env.ts'
import { attempt, guardHeaders, refuse } from './Http.ts'
import { Visibility } from './Model.ts'
import { linkPage } from './Shell.ts'

const fromHere = (request: Request, url: URL) => {
  const origin = request.headers.get('origin')
  const site = request.headers.get('sec-fetch-site')
  const foreign =
    (origin !== null && origin !== url.origin) || (site !== null && site !== 'same-origin') || (origin ?? site) === null
  return foreign ? refuse(403, 'cross_site') : Effect.void
}

const backToIndex = (): Response =>
  new Response(null, { status: 303, headers: { ...guardHeaders, location: '/', 'cache-control': 'no-store' } })

const field = Effect.fn('crit.team.field')(function* (request: Request, name: string) {
  const form = yield* attempt(() => request.formData()).pipe(Effect.option)
  const value = Option.getOrUndefined(form)?.get(name)
  return typeof value === 'string' ? value : ''
})

/** The control at `pathname`, or undefined when the path is not one. `member` is the name Access admitted. */
export const teamControl = (request: Request, env: Env, url: URL, member: string) => {
  const match = /^\/_crit\/pages\/([a-z0-9_][a-z0-9_-]{0,79})\/(visibility|links|links\/revoke)$/u.exec(url.pathname)
  if (match === null) return undefined
  const [, slug = '', action = ''] = match
  return Effect.gen(function* () {
    if (request.method !== 'POST') return yield* refuse(405, 'method_not_allowed')
    yield* fromHere(request, url)
    if (action === 'links') {
      const link = yield* makeLink(env, url.origin, slug, undefined)
      return linkPage(slug, link.url, link.expiresAt)
    }
    if (action === 'links/revoke') {
      yield* revoke(env, slug)
      return backToIndex()
    }
    const wanted = yield* field(request, 'visibility')
    if (!Schema.is(Visibility)(wanted)) return yield* refuse(400, 'invalid_visibility')
    yield* changeVisibility(env, slug, wanted, member)
    return backToIndex()
  })
}
