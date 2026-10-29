import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Schema } from 'effect'
import { oxlintEnv } from './tsrs-lint.ts'

const root = resolve(import.meta.dir, '..')
await mkdir(`${root}/.artifacts`, { recursive: true })
const directory = await mkdtemp(`${root}/.artifacts/checker-canaries-`)
const run = async (args: string[], env = process.env) => {
  const child = Bun.spawn(args, { cwd: root, env, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0 && code !== 1 && code !== 2)
    throw new Error(`Canary checker failed to run (${code}): ${stdout}${stderr}`)
  return { stdout, stderr, code }
}
const Diagnostic = Schema.Struct({ code: Schema.Number, name: Schema.optionalKey(Schema.String) })
const EffectOutput = Schema.Struct({
  diagnostics: Schema.Array(Diagnostic),
  typescriptDiagnostics: Schema.Array(Diagnostic),
  summary: Schema.Struct({ filesChecked: Schema.Number, filesWithoutPlugin: Schema.optionalKey(Schema.Number) }),
})
try {
  await writeFile(
    `${directory}/tsconfig.json`,
    JSON.stringify({ extends: `${root}/tsconfig.json`, files: ['fixture.ts'], include: [], exclude: [] }),
  )
  await writeFile(
    `${directory}/fixture.ts`,
    `import { Effect } from 'effect'
import { format } from '../../packages/i18n/src/index.ts'
export const wrong: string = 42
export const floats = () => { Effect.succeed(1) }
export const missingArgument = format('en', 'foundation.count', {})
`,
  )
  const effect = await run([
    `${root}/node_modules/.bin/effect-tsrs`,
    'diagnostics',
    '-p',
    `${directory}/tsconfig.json`,
    '--type-check',
    '--format',
    'json',
  ])
  const output = Schema.decodeUnknownSync(Schema.fromJsonString(EffectOutput))(effect.stdout)
  if (
    !output.typescriptDiagnostics.some(({ code }) => code === 2322) ||
    !output.typescriptDiagnostics.some(({ code }) => code === 2741) ||
    !output.diagnostics.some(({ name }) => name === 'floatingEffect') ||
    output.summary.filesChecked === 0 ||
    (output.summary.filesWithoutPlugin ?? 0) !== 0
  ) {
    throw new Error(`Type/Effect/i18n canary missed expected errors: ${effect.stdout}`)
  }
  const reference = await run([`${root}/node_modules/.bin/tsrs`, '--noEmit', '-p', `${directory}/tsconfig.json`])
  if (reference.code === 0 || !reference.stdout.includes('TS2322') || !reference.stdout.includes('TS2741'))
    throw new Error(`Reference checker missed canaries: ${reference.stdout}${reference.stderr}`)
  await writeFile(
    `${directory}/fixture.ts`,
    `export const bad = (value: object) => Reflect.get(value, 'key')
Promise.resolve(1)
export const tag = (value: { readonly _tag: 'Ready' | 'Done' }) => value._tag === 'Ready'
`,
  )
  const lint = await run(
    [
      `${root}/node_modules/.bin/oxlint`,
      '-c',
      'oxlint.config.ts',
      '--no-ignore',
      '--tsconfig',
      `${directory}/tsconfig.json`,
      '--format',
      'json',
      `${directory}/fixture.ts`,
    ],
    await oxlintEnv(),
  )
  for (const rule of ['no-floating-promises', 'no-reflect-get', 'no-manual-tag-comparison'])
    if (lint.code !== 1 || !lint.stdout.includes(rule))
      throw new Error(`Lint canary missed ${rule}: ${lint.stdout}${lint.stderr}`)
  console.log(
    'Checker canaries: TypeScript, Effect, typed i18n, type-aware lint and anti-slop all rejected invalid code',
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}
