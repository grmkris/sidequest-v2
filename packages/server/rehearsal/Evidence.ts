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

/** Which gate a rehearsal rehearses: phase 1's, through accounts and MCP, or phase 2's, through signed events, from a
 * script or from the website in Chromium. */
export type Rehearsal = 'phase-1-technical-gate' | 'phase-2-events-gate' | 'phase-2-browser-gate'

const titles: Readonly<Record<Rehearsal, string>> = {
  'phase-1-technical-gate': 'Phase 1 technical gate rehearsal',
  'phase-2-events-gate': 'Phase 2 gate rehearsal through signed events',
  'phase-2-browser-gate': 'Phase 2 gate rehearsal on the website, in Chromium',
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
  durationMs?: number
}

const started = Date.now()

/** A new evidence record for one run. */
export const evidenceFor = (
  mode: string,
  release: string,
  chain: Readonly<Record<string, string | number>>,
  rehearsal: Rehearsal = 'phase-1-technical-gate',
): Evidence => ({
  rehearsal,
  mode,
  startedAt: new Date(started).toISOString(),
  release,
  chain,
  steps: [],
  cases: [],
})

/** Record one step of a case. */
export const step = (evidence: Evidence, entry: Omit<Step, 'at'>) => {
  evidence.steps.push({ ...entry, at: Date.now() - started })
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
  return lines.join('\n')
}
