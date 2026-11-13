import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { Schema } from 'effect'

// `bun run gate:rehearse`: the phase 1 technical gate, rehearsed end to end on a local chain (the default) or, with
// REHEARSAL_CHAIN=arc-testnet and the variables packages/server/rehearsal/Chain.ts names, against Arc testnet.
// It builds the website, runs packages/server/rehearsal/GateRehearsal.native.test.ts (the whole stack in workerd, the
// hires over HTTP and MCP) and prints the evidence it wrote to .artifacts/gate-rehearsal/<mode>.json.
//
// `bun run gate:rehearse:events` (REHEARSAL_PATH=events): the same hires Nostr-native, through signed events and the
// sessionless escrow endpoints (packages/server/rehearsal/EventsRehearsal.native.test.ts), on a local chain only; its
// evidence is .artifacts/gate-rehearsal/<mode>-events.json.
//
// Arc testnet sends real testnet transactions from the keys given, so it runs only when asked for by name; it refuses
// any chain but Arc testnet, and never a mainnet.

const mode = process.env['REHEARSAL_CHAIN'] === 'arc-testnet' ? 'arc-testnet' : 'anvil'
const events = process.env['REHEARSAL_PATH'] === 'events'
if (events && mode !== 'anvil') {
  console.error('The events rehearsal runs on a local chain only: unset REHEARSAL_CHAIN.')
  process.exit(2)
}
const file = events ? 'EventsRehearsal' : 'GateRehearsal'
const written = events ? `${mode}-events` : mode
const release = process.env['VITE_SIDEQUEST_RELEASE'] ?? 'rehearsal'
const environment = { ...process.env, VITE_SIDEQUEST_RELEASE: release, ALCHEMY_TEST_DEV: '1' }

const run = (command: string, args: ReadonlyArray<string>) => {
  const result = spawnSync(command, args, { stdio: 'inherit', env: environment })
  return result.status ?? 1
}

const started = Date.now()
const built = run('bun', ['run', 'build'])
if (built !== 0) process.exit(built)
const status = run('bun', ['test', '--timeout', '900000', `packages/server/rehearsal/${file}.native.test.ts`])

const evidence = new URL(`../.artifacts/gate-rehearsal/${written}.json`, import.meta.url)
if (existsSync(evidence)) {
  const Evidence = Schema.fromJsonString(
    Schema.Struct({ cases: Schema.Array(Schema.Struct({ case: Schema.String, status: Schema.String })) }),
  )
  const { cases } = Schema.decodeUnknownSync(Evidence)(readFileSync(evidence, 'utf8'))
  console.log(
    `Gate rehearsal${events ? ' through events' : ''} on ${mode}: ${cases.map((result) => `${result.case} ${result.status}`).join(', ')}`,
  )
  console.log(`Evidence: ${evidence.pathname}; ${Math.round((Date.now() - started) / 1000)} s with the build`)
}
process.exit(status)
