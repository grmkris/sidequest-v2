import { EmailDelivery as Mail, Proofs } from '@yielded/auth'
import { format, normalizeLocale } from '@sidequest/i18n'
import { Context, Data, DateTime, Effect, Layer, Predicate, Redacted } from 'effect'

/** The builder form of Cloudflare's `send_email` binding, structurally. The Worker passes the
 * native binding (`yield* email.raw` from `Cloudflare.Email.Send(SidequestEmail)`), so this package
 * stays free of Alchemy and RuntimeContext. */
export interface CloudflareEmailSender {
  readonly send: (message: {
    readonly from: string
    readonly to: string
    readonly subject: string
    readonly text: string
    readonly html?: string
  }) => Promise<unknown>
}

/** Provider acceptance only, never retried (Y/email-delivery/service.ts:31-41). Cloudflare does not
 * tell us whether a rejected call was definitely not accepted, so every failure is ambiguous. No span
 * and no log here: the recipient and body are private (EmailProofDelivery already disables tracing). */
export const emailDeliveryLayer = (sender: CloudflareEmailSender, from: string) =>
  Layer.succeed(
    Mail.EmailDelivery,
    Mail.EmailDelivery.of({
      send: (message) =>
        Effect.tryPromise({
          try: () =>
            sender.send({
              from,
              to: message.to,
              subject: message.subject,
              text: Redacted.value(message.text),
              ...(message.html === undefined ? {} : { html: Redacted.value(message.html) }),
            }),
          catch: () => Mail.EmailAcceptanceUnknown.make({}),
        }).pipe(Effect.asVoid),
    }),
  )

/** Sidequest's strategies send numeric codes only; any other template is a wiring defect. */
class OnlyNumericCodes extends Data.TaggedError('OnlyNumericCodes')<{}> {}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`)

/** en/sl copy from the reviewed catalogs (catalogs.json in this draft). Purposes come from
 * Yielded's proof modules: `email-code-sign-in` and `email-code-registration`. */
export const emailRendererLayer = Layer.succeed(Mail.EmailRenderer, {
  render: Effect.fnUntraced(function* (template: Mail.EmailTemplate) {
    if (!Predicate.isTagged(template.content, 'Code')) return yield* Effect.die(new OnlyNumericCodes())
    const locale = normalizeLocale(template.locale)
    const code = Redacted.value(template.content.code)
    const now = DateTime.toEpochMillis(yield* DateTime.now)
    const minutes = Math.max(1, Math.ceil((template.expiresAtMillis - now) / 60_000))
    const registering = template.purpose === 'email-code-registration'
    const subject = format(locale, registering ? 'authEmail.subjectRegistration' : 'authEmail.subjectSignIn', { code })
    const heading = format(locale, registering ? 'authEmail.headingRegistration' : 'authEmail.headingSignIn', {})
    const instructions = format(locale, 'authEmail.instructions', {})
    const expiry = format(locale, 'authEmail.expiry', { minutes })
    const ignore = format(locale, 'authEmail.ignore', {})
    const text = [heading, '', instructions, '', code, '', expiry, ignore].join('\n')
    const html = `<!doctype html><html lang="${locale}"><body style="margin:0;padding:24px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#141414;background:#ffffff">
<h1 style="font-size:20px;font-weight:600;margin:0 0 16px">${escapeHtml(heading)}</h1>
<p style="font-size:15px;line-height:1.5;margin:0 0 16px">${escapeHtml(instructions)}</p>
<p style="font-size:32px;font-weight:600;letter-spacing:6px;margin:0 0 16px;font-variant-numeric:tabular-nums">${escapeHtml(code)}</p>
<p style="font-size:13px;line-height:1.5;color:#5c5c5c;margin:0">${escapeHtml(expiry)} ${escapeHtml(ignore)}</p>
</body></html>`
    return { subject, text: Redacted.make(text), html: Redacted.make(html) }
  }),
})

/** The per-request release boundary for proof delivery. Yielded's default scheduler forks a worker
 * into the auth Layer's scope (Y/proofs/ProofDispatchScheduler.ts:38-61): in workerd that scope
 * outlives the request whose I/O context it captured. The Worker installs `waitUntil` here around
 * each request; the default awaits inline (tests, scripts), which exposes provider latency and must
 * not be the production path (`layerInline`, :74). */
export const ProofDispatchSink = Context.Reference<(work: Effect.Effect<void>) => Effect.Effect<void>>(
  '@sidequest/auth/ProofDispatchSink',
  { defaultValue: () => (work) => work },
)

/** Every committed issue, including suppressed ones, schedules exactly one task (Y/proofs/module.ts:375),
 * so eligible and ineligible requests take the same path to the response. */
export const proofDispatchSchedulerLayer = Layer.succeed(
  Proofs.ProofDispatchScheduler,
  Proofs.ProofDispatchScheduler.of({
    schedule: (work) =>
      Effect.gen(function* () {
        const sink = yield* ProofDispatchSink
        yield* sink(work)
      }),
  }),
)
