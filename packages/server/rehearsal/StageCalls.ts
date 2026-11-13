import { Option, Predicate, Schema } from 'effect'
import { type Evidence, sinceStart, type StageCall, type Step } from './Evidence.ts'

// Every request the rehearsal sends to a deployed stage, whoever sends it (the HTTP helpers, the MCP client, OAuth):
// timed and recorded, kept inside the stage's rate limits, and sent again when the stage answers 429 after the time it
// names. The rehearsal's process sends them all through `fetch`, so this wraps that one function for the run.

/**
 * The escrow endpoints' limit is 30 requests a minute per client address (`EscrowHttp.ts`); the rehearsal keeps to 25,
 * leaving room for a request it sends again. Publishing (120 a minute per address, 30 per key) and the gateway's
 * per-agent limits (120 calls, 20 writes a minute) are far above what a case sends; a 429 from any is waited out.
 */
export const escrowPerMinute = 25

/** The escrow group's paths (`packages/protocol/src/EscrowGroup.ts`), all counted against the one limit. */
const escrowPath =
  /^\/api\/index\/jobs\/[0-9a-f]{64}\/(?:proposals\/[0-9a-f]{64}\/funding|delivery|delivery-delegation|delegated-delivery|approval|rejection|ruling|payment)$/u

/** At most this many answers of 429 in a row for one request before its last answer is returned as it is. */
const maxWaits = 6

const Limited = Schema.Struct({ retryAfterSeconds: Schema.Int })

/** How long the stage asked to wait: its `retry-after` header, else the `RateLimited` body's `retryAfterSeconds`. */
const retryAfterOf = async (response: Response) => {
  const header = Number(response.headers.get('retry-after') ?? '')
  if (Number.isFinite(header) && header > 0) return header
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => undefined)
  return Option.match(Schema.decodeUnknownOption(Limited)(body), {
    onNone: () => 60,
    onSome: ({ retryAfterSeconds }) => retryAfterSeconds,
  })
}

const sleep = (millis: number) => new Promise((resolve) => setTimeout(resolve, millis))

/** The requests made so far, for the stage at `hosts`, and how to stop observing. */
export interface StageCalls {
  readonly calls: ReadonlyArray<StageCall>
  readonly stop: () => void
}

/**
 * Wraps the process's `fetch` for the run: requests to `hosts` are paced (the escrow endpoints at
 * {@link escrowPerMinute}), sent again after a 429 as the stage asks, and recorded; any other request passes untouched.
 */
export const observeStage = (hosts: ReadonlyArray<string>): StageCalls => {
  const base = globalThis.fetch
  const calls: Array<StageCall> = []
  const escrowSent: Array<number> = []
  const paced = async () => {
    for (;;) {
      const now = Date.now()
      const recent = escrowSent.filter((at) => at > now - 60_000)
      escrowSent.splice(0, escrowSent.length, ...recent)
      if (recent.length < escrowPerMinute) return escrowSent.push(now)
      await sleep((recent[0] ?? now) + 60_001 - now)
    }
  }
  const observed = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (!hosts.includes(url.host)) return base(input, init)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    if (escrowPath.test(url.pathname)) await paced()
    for (let waits = 0; ; waits += 1) {
      const sentAt = Date.now()
      const at = sinceStart()
      const response = await base(input, init)
      const ms = Date.now() - sentAt
      const call = { at, method, url: `${url.host}${url.pathname}`, status: response.status, ms }
      // A request object's body is spent once sent; the rehearsal's own requests are a URL and a string body.
      if (response.status !== 429 || waits >= maxWaits || input instanceof Request) {
        calls.push(call)
        return response
      }
      const retryAfter = await retryAfterOf(response)
      calls.push({ ...call, retryAfter })
      await sleep((retryAfter + 1) * 1000)
    }
  }
  globalThis.fetch = Object.assign(observed, { preconnect: base.preconnect })
  return {
    calls,
    stop: () => {
      globalThis.fetch = base
    },
  }
}

/** Each step with the requests made since the step before it, up to it. */
export const withCalls = (steps: ReadonlyArray<Step>, calls: ReadonlyArray<StageCall>): Array<Step> =>
  steps.map((entry, index) => {
    const after = steps[index - 1]?.at ?? -1
    const made = calls.filter((call) => call.at > after && call.at <= entry.at)
    return made.length === 0 ? entry : { ...entry, calls: made }
  })

/** The requests by status, the slowest, and how many the stage limited: the stage's side of the evidence. */
export const callSummary = (calls: ReadonlyArray<StageCall>, evidence: Evidence) => {
  const byStatus = new Map<number, number>()
  for (const call of calls) byStatus.set(call.status, (byStatus.get(call.status) ?? 0) + 1)
  const slowest = calls.reduce<StageCall | undefined>(
    (worst, call) => (worst === undefined || call.ms > worst.ms ? call : worst),
    undefined,
  )
  return {
    ...evidence.stage,
    requests: calls.length,
    byStatus: [...byStatus].map(([status, count]) => `${status}: ${count}`).join(', '),
    rateLimited: calls.filter((call) => Predicate.isNumber(call.retryAfter)).length,
    slowest: slowest === undefined ? 'none' : `${slowest.method} ${slowest.url} ${slowest.ms} ms`,
  }
}
