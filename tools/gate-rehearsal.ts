import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { Schema } from 'effect'

// `bun run gate:rehearse`: the phase 2 technical gate, through signed events, the escrow endpoints and the agent
// gateway over MCP (tools/rehearsal/GateRehearsal.native.test.ts), on a local chain (the default) or, with
// REHEARSAL_CHAIN=arc-testnet and the variables packages/server/rehearsal/Chain.ts names (REHEARSAL_OPERATOR_DEPLOY_BLOCK
// among them), on Arc testnet. It builds the website, runs the rehearsal (the whole stack in workerd) and prints the
// evidence it wrote to .artifacts/gate-rehearsal/<mode>.json.
//
// `bun run gate:rehearse:browser` (REHEARSAL_PATH=browser): a hire released and one rejected on the website, by two
// people in Chromium with a NIP-07 extension and a test wallet each (BrowserRehearsal.native.test.ts), on a local chain
// only; its evidence is .artifacts/gate-rehearsal/<mode>-browser.json.
//
// With REHEARSAL_TARGET (a deployed stage's site, e.g. https://v2.sidequest.exchange), REHEARSAL_GATEWAY (its gateway)
// and REHEARSAL_CHAIN=arc-testnet: the same gate against that deployed stage, deploying and building nothing
// (tools/rehearsal/DeployedRehearsal.native.test.ts, packages/server/rehearsal/DeployedWorld.ts); its evidence is
// .artifacts/gate-rehearsal/arc-testnet-deployed.json.
//
// Arc testnet sends real testnet transactions from the keys given, so it runs only when asked for by name; it refuses
// any chain but Arc testnet, and never a mainnet.

const mode = process.env['REHEARSAL_CHAIN'] === 'arc-testnet' ? 'arc-testnet' : 'anvil'
const browser = process.env['REHEARSAL_PATH'] === 'browser'
const deployed = (process.env['REHEARSAL_TARGET'] ?? '') !== ''
if (browser && mode !== 'anvil') {
  console.error('The browser rehearsal runs on a local chain only: unset REHEARSAL_CHAIN.')
  process.exit(2)
}
if (deployed && (browser || mode !== 'arc-testnet')) {
  console.error(
    'A deployed stage is rehearsed on Arc testnet only, without the browser: set REHEARSAL_CHAIN=arc-testnet.',
  )
  process.exit(2)
}
const file = deployed
  ? 'tools/rehearsal/DeployedRehearsal.native.test.ts'
  : browser
    ? 'packages/server/rehearsal/BrowserRehearsal.native.test.ts'
    : 'tools/rehearsal/GateRehearsal.native.test.ts'
const written = deployed ? `${mode}-deployed` : browser ? `${mode}-browser` : mode
const release = process.env['VITE_SIDEQUEST_RELEASE'] ?? 'rehearsal'
const environment = { ...process.env, VITE_SIDEQUEST_RELEASE: release, ALCHEMY_TEST_DEV: '1' }

const run = (command: string, args: ReadonlyArray<string>) => {
  const result = spawnSync(command, args, { stdio: 'inherit', env: environment })
  return result.status ?? 1
}

const started = Date.now()
const built = deployed ? 0 : run('bun', ['run', 'build'])
if (built !== 0) process.exit(built)
const status = run('bun', ['test', '--timeout', '1200000', file])

const evidence = new URL(`../.artifacts/gate-rehearsal/${written}.json`, import.meta.url)
if (existsSync(evidence)) {
  const Evidence = Schema.fromJsonString(
    Schema.Struct({ cases: Schema.Array(Schema.Struct({ case: Schema.String, status: Schema.String })) }),
  )
  const { cases } = Schema.decodeUnknownSync(Evidence)(readFileSync(evidence, 'utf8'))
  console.log(
    `Gate rehearsal${browser ? ' (browser)' : deployed ? ' (deployed stage)' : ''} on ${mode}: ${cases.map((result) => `${result.case} ${result.status}`).join(', ')}`,
  )
  console.log(`Evidence: ${evidence.pathname}; ${Math.round((Date.now() - started) / 1000)} s with the build`)
}
process.exit(status)
