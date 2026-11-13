import { format } from '@sidequest/i18n'
import type { EventTemplate, NostrEvent } from '@sidequest/nostr'
import { EventInvalid, EventInvalidReason, EventTooLarge, KindNotIndexed, RateLimited } from '@sidequest/protocol'
import { Clock, Effect, Option, Schema } from 'effect'
import type { Html } from 'foldkit'
import { defineTaggedUnion } from 'foldkit/schema'
import { SidequestClient } from './Api.ts'
import type { Language } from './Language.ts'
import type * as NostrKit from './NostrKit.ts'
import { Problem, problemOf } from './Problem.ts'
import { SignerFailed, SignerFailure, Signers } from './Signer.ts'
import { type PlainKey, say } from './Text.ts'
import * as Ui from './Ui.ts'

// Before funding, everything a person does on the site is a signed Nostr event (ADR-0003): a page builds its template
// with the lazily loaded Nostr code, the person's signer signs it, and the index takes it through `POST /api/events`.

/** Now, in the whole seconds events carry. */
export const nowSeconds = Effect.map(Clock.currentTimeMillis, (millis) => Math.floor(millis / 1000))

/** The index's typed refusal of an event. */
export const PublishRefusal = defineTaggedUnion({
  Invalid: { reason: EventInvalidReason },
  KindNotIndexed: {},
  TooLarge: {},
  RateLimited: { retryAfterSeconds: Schema.Int },
})
export type PublishRefusal = typeof PublishRefusal.Type

/** Why an event was not published: the index refused it, the signer could not sign it, or something else. */
export const PublishFailure = defineTaggedUnion({
  Refused: { refusal: PublishRefusal },
  SignerFailed: { reason: SignerFailure },
  Failed: { problem: Problem },
})
export type PublishFailure = typeof PublishFailure.Type

/** What a page asked to sign is not content the vocabulary takes; the index would refuse it the same way. */
class Unbuildable extends Schema.TaggedError<Unbuildable>()('Unbuildable', {}) {}

/** The index's refusal, the signer's failure, or any other problem, as a {@link PublishFailure}. */
export const publishFailureOf = (error: unknown): PublishFailure => {
  if (error instanceof Unbuildable) {
    return PublishFailure.Refused({ refusal: PublishRefusal.Invalid({ reason: 'badContent' }) })
  }
  if (error instanceof SignerFailed) {
    return PublishFailure.SignerFailed({ reason: error.reason })
  }
  if (error instanceof EventInvalid) {
    return PublishFailure.Refused({ refusal: PublishRefusal.Invalid({ reason: error.reason }) })
  }
  if (error instanceof KindNotIndexed) {
    return PublishFailure.Refused({ refusal: PublishRefusal.KindNotIndexed() })
  }
  if (error instanceof EventTooLarge) {
    return PublishFailure.Refused({ refusal: PublishRefusal.TooLarge() })
  }
  if (error instanceof RateLimited) {
    return PublishFailure.Refused({
      refusal: PublishRefusal.RateLimited({ retryAfterSeconds: error.retryAfterSeconds }),
    })
  }
  return PublishFailure.Failed({ problem: problemOf(error) })
}

/** Builds the template with the Nostr code at the time of signing, signs it with the person's signer and publishes it
 * through the index: the event as published. */
export const publishEvent = (
  build: (kit: typeof NostrKit, createdAt: number) => Effect.Effect<Option.Option<EventTemplate>>,
): Effect.Effect<NostrEvent, unknown, Signers | SidequestClient> =>
  Effect.gen(function* () {
    const signers = yield* Signers
    const kit = yield* signers.kit
    const template = yield* build(kit, yield* nowSeconds)
    if (Option.isNone(template)) {
      return yield* new Unbuildable()
    }
    const signer = yield* signers.resume
    const event = yield* signer.signEvent(template.value)
    const api = yield* (yield* SidequestClient).api
    yield* api.events.publish({ payload: event })
    return event
  })

// VIEW

const signatureReasons: ReadonlyArray<typeof EventInvalidReason.Type> = ['malformed', 'idMismatch', 'badSignature']

/** The index's refusal in one sentence. */
export const refusalText = (language: Language, refusal: PublishRefusal): string =>
  PublishRefusal.match(refusal, {
    Invalid: ({ reason }) =>
      say(language, signatureReasons.includes(reason) ? 'publish.refused.signature' : 'publish.refused.content'),
    KindNotIndexed: () => say(language, 'publish.refused.kind'),
    TooLarge: () => say(language, 'publish.refused.tooLarge'),
    RateLimited: ({ retryAfterSeconds }) =>
      format(language, 'publish.refused.rateLimited', { seconds: retryAfterSeconds }),
  })

const signerKeys: Readonly<Record<SignerFailure, PlainKey>> = {
  noExtension: 'signer.problem.noExtension',
  extensionRefused: 'signer.problem.extensionRefused',
  extensionUntrusted: 'signer.problem.extensionUntrusted',
  locked: 'publish.signerLocked',
  wrongPassword: 'signer.problem.wrongPassword',
  notABackup: 'signer.problem.notABackup',
  nothingStored: 'publish.signerLocked',
  notLoaded: 'signer.problem.notLoaded',
}

/** Why the signer could not sign, in one sentence. */
export const signerFailureText = (language: Language, reason: SignerFailure): string =>
  say(language, signerKeys[reason])

/** Why a publication failed; a signer that is not ready links to the identity page, which comes back to `next`. */
export const publishFailureNotice = <Message>(
  h: Html.HtmlBuilder<Message>,
  language: Language,
  failure: PublishFailure,
  identityHref: string,
): Html.Html =>
  PublishFailure.match(failure, {
    Refused: ({ refusal }) => Ui.notice(h, 'danger', [h.p([], [refusalText(language, refusal)])]),
    SignerFailed: ({ reason }) =>
      Ui.notice(h, 'danger', [
        h.p([], [signerFailureText(language, reason)]),
        h.p([], [h.a([h.Href(identityHref)], [say(language, 'me.setUpLink')])]),
      ]),
    Failed: ({ problem }) => Ui.problemNotice(h, language, problem),
  })
