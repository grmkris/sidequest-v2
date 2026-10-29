import { oxlintEnv } from './tsrs-lint.ts'

const child = Bun.spawn([`${import.meta.dir}/../node_modules/.bin/oxlint`, ...Bun.argv.slice(2)], {
  cwd: `${import.meta.dir}/..`,
  env: await oxlintEnv(),
  stdio: ['inherit', 'inherit', 'inherit'],
})
process.exit(await child.exited)
