import { mkdirSync, writeFileSync } from 'node:fs'
import type { MethodCensus } from './RpcProxy.ts'

// The rehearsal's evidence: every step with its time and transaction, each case's balances and outcome, and the
// relayer's account of its nonces. Written as JSON to a git-ignored path, and summarised for a person to read.

export interface Step {
  readonly case: string
  readonly step: string
  /** Milliseconds since the rehearsal started. */
  readonly at: number
  readonly transactionHash?: string
  readonly detail?: Readonly<Record<string, string | number | boolean>>
  /** The requests to a deployed stage since the step before, up to this one. */
  readonly calls?: ReadonlyArray<StageCall>
}

/** One request to a deployed stage: when it was sent, what, how it answered and how long it took. */
export interface StageCall {
  /** Milliseconds since the rehearsal started, when the request was sent. */
  readonly at: number
  readonly method: string
  /** The host and path, without the query. */
  readonly url: string
  readonly status: number
  readonly ms: number
  /** Seconds the rehearsal waited before sending it again, when the stage answered 429. */
  readonly retryAfter?: number
}

export interface Balance {
  readonly party: string
  readonly address: string
  readonly before: string
  readonly after: string
  readonly change: string
  readonly expected: string
}

export interface CaseResult {
  readonly case: string
  readonly title: string
  readonly status: 'passed' | 'failed' | 'not run'
  readonly reason?: string
  readonly job?: string
  readonly paymentHash?: string
  readonly outcome?: string
  readonly settlement?: ReadonlyArray<string>
  readonly balances?: ReadonlyArray<Balance>
  readonly inbox?: Readonly<Record<string, ReadonlyArray<string>>>
  readonly durationMs?: number
}

export interface RelayerAccount {
  readonly address: string
  readonly transactions: number
  readonly calls: number
  readonly releases: number
  readonly withheld: number
  readonly latestNonce: number
  readonly pendingNonce: number
  readonly intents: Readonly<Record<string, number>> | string
  /** Every transaction the relayer handed the node, in order: nonce, function (or `transfer`), refused or not. */
  readonly sent: ReadonlyArray<{
    readonly hash: string
    readonly nonce: number
    readonly function: string
    readonly withheld: boolean
    readonly at: number
  }>
}

/** Which rehearsal of the phase 2 gate: through signed events, the escrow endpoints and the gateway from a script, or
 * on the website in Chromium. Evidence files carry the name. */
export type Rehearsal = 'phase-2-events-gate' | 'phase-2-browser-gate' | 'phase-2-deployed-gate'

const titles: Readonly<Record<Rehearsal, string>> = {
  'phase-2-events-gate': 'Phase 2 gate rehearsal through signed events',
  'phase-2-browser-gate': 'Phase 2 gate rehearsal on the website, in Chromium',
  'phase-2-deployed-gate': 'Phase 2 gate rehearsal against a deployed stage',
}

export interface Evidence {
  readonly rehearsal: Rehearsal
  readonly mode: string
  readonly startedAt: string
  readonly release: string
  readonly chain: Readonly<Record<string, string | number>>
  readonly steps: Array<Step>
  readonly cases: Array<CaseResult>
  relayer?: RelayerAccount
  /** Every JSON-RPC request the stack and the rehearsal sent through the proxy, by method. */
  rpc?: Readonly<Record<string, MethodCensus>>
  /** A deployed stage: what it reported of itself, and its requests' answers by status. */
  stage?: Readonly<Record<string, string | number>>
  durationMs?: number
}

const started = Date.now()

/** A new evidence record for one run. */
export const evidenceFor = (
  mode: string,
  release: string,
  chain: Readonly<Record<string, string | number>>,
  rehearsal: Rehearsal,
): Evidence => ({
  rehearsal,
  mode,
  startedAt: new Date(started).toISOString(),
  release,
  chain,
  steps: [],
  cases: [],
})

/** Milliseconds since the rehearsal started. */
export const sinceStart = () => Date.now() - started

/** Record one step of a case. */
export const step = (evidence: Evidence, entry: Omit<Step, 'at'>) => {
  evidence.steps.push({ ...entry, at: sinceStart() })
}

/** Runs one case and records its result, passed or failed (a thrown error is the reason it failed). */
export const recordCase = async (
  evidence: Evidence,
  name: string,
  title: string,
  run: () => Promise<CaseResult>,
): Promise<CaseResult> => {
  const outcome = await run().then(
    (result) => result,
    (cause: unknown): CaseResult => ({ case: name, title, status: 'failed', reason: String(cause) }),
  )
  evidence.cases.push(outcome)
  return outcome
}

/** Where a mode's evidence is written: under `.artifacts/`, which git ignores. */
export const evidencePath = (mode: string) =>
  new URL(`../../../.artifacts/gate-rehearsal/${mode}.json`, import.meta.url)

export const writeEvidence = (evidence: Evidence) => {
  evidence.durationMs = Date.now() - started
  const path = evidencePath(evidence.mode)
  mkdirSync(new URL('.', path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`)
  return path
}

/** The stack's requests to the chain through the proxy, and which methods failed and how. */
const rpcLines = (evidence: Evidence): ReadonlyArray<string> => {
  const methods = Object.entries(evidence.rpc ?? {})
  if (methods.length === 0) return []
  const requests = methods.reduce((sum, [, method]) => sum + method.requests, 0)
  const failed = methods
    .filter(([, method]) => method.failed > 0)
    .map(([name, method]) => `${name} ${method.failed} failed (${method.failures.join('; ')})`)
  return [`  rpc through the proxy: ${requests} requests, ${failed.length === 0 ? 'none failed' : failed.join(', ')}`]
}

/** A summary a person reads: each case, its outcome and balances, and the relayer's nonces. */
export const summaryOf = (evidence: Evidence) => {
  const lines = [
    `${titles[evidence.rehearsal]} on ${evidence.mode} (release ${evidence.release}), ${Math.round((evidence.durationMs ?? 0) / 1000)} s`,
  ]
  for (const result of evidence.cases) {
    lines.push(
      `  ${result.case}) ${result.title}: ${result.status.toUpperCase()}${result.reason === undefined ? '' : ` (${result.reason})`}`,
    )
    if (result.outcome !== undefined)
      lines.push(`     job ${result.job} settled ${result.outcome} [${(result.settlement ?? []).join(', ')}]`)
    for (const balance of result.balances ?? [])
      lines.push(`     ${balance.party.padEnd(9)} ${balance.change.padStart(12)} (expected ${balance.expected})`)
  }
  const relayer = evidence.relayer
  if (relayer !== undefined)
    lines.push(
      `  relayer ${relayer.address}: ${relayer.transactions} sent (${relayer.calls} calls, ${relayer.releases} releases, ${relayer.withheld} withheld by the node); nonce ${relayer.latestNonce} mined, ${relayer.pendingNonce} pending; intents ${typeof relayer.intents === 'string' ? relayer.intents : JSON.stringify(relayer.intents)}`,
    )
  lines.push(...rpcLines(evidence))
  const stage = Object.entries(evidence.stage ?? {})
  if (stage.length > 0) lines.push(`  stage: ${stage.map(([name, value]) => `${name} ${value}`).join('; ')}`)
  return lines.join('\n')
}
