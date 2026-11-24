/**
 * Plans, then deploys this project's crit (alchemy.run.ts). Needed only when the Worker or crit.config.ts change:
 * pages are published, never deployed. Credentials: the account pair scripts/cloud.ts reads, and the publish token
 * from `site.publishEnv`, which becomes the Worker's secret; `CRIT_TEAM` there adds people to the team (team.ts). A shell set up for the local tests is refused: their
 * stand-in for Cloudflare Access must never reach a deploy.
 *
 *   bun run deploy          plan, then deploy
 *   bun run deploy --plan   plan only
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { site } from '../crit.config.ts'
import { accountPair } from './cloud.ts'
import { readSecrets } from './secrets.ts'

const app = join(import.meta.dir, '..')
const published = readSecrets(site.publishEnv)
const publishToken = published.get('CRIT_PUBLISH_TOKEN') ?? ''
if (publishToken.length < 32) throw new Error(`Set CRIT_PUBLISH_TOKEN (32 characters or more) in ${site.publishEnv}`)

if (process.env['ALCHEMY_TEST_DEV'] !== undefined) {
  throw new Error('ALCHEMY_TEST_DEV is set: this shell is for the local tests, and a deploy from it is refused')
}

// The site's own account pair wins over whatever the shell holds for another project.
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^(CLOUDFLARE_|CRIT_|ALCHEMY_STAGE)/u.test(name)),
)
const env = {
  ...inherited,
  ...accountPair(),
  CRIT_PUBLISH_TOKEN: publishToken,
  // The team listed outside Git, if any (team.ts).
  CRIT_TEAM: published.get('CRIT_TEAM') ?? '',
  ALCHEMY_PLAIN: '1',
  ALCHEMY_TELEMETRY_DISABLED: '1',
}
const alchemy = join(dirname(Bun.resolveSync('alchemy/package.json', app)), 'bin', 'alchemy.js')

const run = (action: 'plan' | 'deploy') => {
  const args = [alchemy, action, 'alchemy.run.ts', '--stage', 'prod', '--no-input']
  const result = spawnSync('bun', action === 'deploy' ? [...args, '--yes'] : args, { cwd: app, stdio: 'inherit', env })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run('plan')
if (!process.argv.includes('--plan')) run('deploy')
