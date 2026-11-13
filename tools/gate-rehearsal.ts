import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { Schema } from 'effect'

// `bun run gate:rehearse`: the phase 1 technical gate, rehearsed end to end on a local chain (the default) or, with
// REHEARSAL_CHAIN=arc-testnet and the variables packages/server/rehearsal/Chain.ts names, against Arc testnet.
// It builds the website, runs packages/server/rehearsal/GateRehearsal.native.test.ts (the whole stack in workerd, the
// hires over HTTP and MCP) and prints the evidence it wrote to .artifacts/gate-rehearsal/<mode>.json.
//
// `bun run gate:rehearse:events` (REHEARSAL_PATH=events): the phase 2 gate, Nostr-native, through signed events, the
// sessionless escrow endpoints and the agent gateway over MCP (tools/rehearsal/EventsRehearsal.native.test.ts), on a
// local chain or, with REHEARSAL_CHAIN=arc-testnet and REHEARSAL_OPERATOR_DEPLOY_BLOCK besides phase 1's variables, on
// Arc testnet; its evidence is .artifacts/gate-rehearsal/<mode>-events.json.
//
// `bun run gate:rehearse:browser` (REHEARSAL_PATH=browser): a hire released and one rejected on the website, by two
// people in Chromium with a NIP-07 extension and a test wallet each (BrowserRehearsal.native.test.ts), on a local chain
// only; its evidence is .artifacts/gate-rehearsal/<mode>-browser.json.
//
// Arc testnet sends real testnet transactions from the keys given, so it runs only when asked for by name; it refuses
// any chain but Arc testnet, and never a mainnet.

const mode = process.env['REHEARSAL_CHAIN'] === 'arc-testnet' ? 'arc-testnet' : 'anvil'
const paths = { events: 'EventsRehearsal', browser: 'BrowserRehearsal' } as const
const path = Object.keys(paths).find((name) => name === process.env['REHEARSAL_PATH'])
if (path === 'browser' && mode !== 'anvil') {
  console.error(`The ${path} rehearsal runs on a local chain only: unset REHEARSAL_CHAIN.`)
  process.exit(2)
}
const file =
  path === 'events'
    ? `tools/rehearsal/${paths.events}`
    : `packages/server/rehearsal/${path === 'browser' ? paths.browser : 'GateRehearsal'}`
const written = path === undefined ? mode : `${mode}-${path}`
const release = process.env['VITE_SIDEQUEST_RELEASE'] ?? 'rehearsal'
const environment = { ...process.env, VITE_SIDEQUEST_RELEASE: release, ALCHEMY_TEST_DEV: '1' }

const run = (command: string, args: ReadonlyArray<string>) => {
  const result = spawnSync(command, args, { stdio: 'inherit', env: environment })
  return result.status ?? 1
}

const started = Date.now()
const built = run('bun', ['run', 'build'])
if (built !== 0) process.exit(built)
const status = run('bun', ['test', '--timeout', '1200000', `${file}.native.test.ts`])

const evidence = new URL(`../.artifacts/gate-rehearsal/${written}.json`, import.meta.url)
if (existsSync(evidence)) {
  const Evidence = Schema.fromJsonString(
    Schema.Struct({ cases: Schema.Array(Schema.Struct({ case: Schema.String, status: Schema.String })) }),
  )
  const { cases } = Schema.decodeUnknownSync(Evidence)(readFileSync(evidence, 'utf8'))
  console.log(
    `Gate rehearsal${path === undefined ? '' : ` (${path})`} on ${mode}: ${cases.map((result) => `${result.case} ${result.status}`).join(', ')}`,
  )
  console.log(`Evidence: ${evidence.pathname}; ${Math.round((Date.now() - started) / 1000)} s with the build`)
}
process.exit(status)
