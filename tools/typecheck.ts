import { Schema } from 'effect'
import { readFile } from 'node:fs/promises'

const Diagnostic = Schema.Struct({
  severity: Schema.String,
  message: Schema.String,
  code: Schema.Number,
  name: Schema.optional(Schema.String),
  file: Schema.optional(Schema.String),
  line: Schema.optional(Schema.Number),
})
const Output = Schema.Struct({
  diagnostics: Schema.Array(Diagnostic),
  typescriptDiagnostics: Schema.Array(Diagnostic),
  summary: Schema.Struct({ filesChecked: Schema.Number, filesWithoutPlugin: Schema.optional(Schema.Number) }),
})
const Config = Schema.Struct({
  compilerOptions: Schema.Struct({ plugins: Schema.Array(Schema.Struct({ name: Schema.String })) }),
})
const root = `${import.meta.dir}/..`
const config = Schema.decodeUnknownSync(Schema.fromJsonString(Config))(await readFile(`${root}/tsconfig.json`, 'utf8'))
if (!config.compilerOptions.plugins.some((plugin) => plugin.name === '@effect/language-service'))
  throw new Error('Effect diagnostics must be enabled')
const child = Bun.spawn(
  [
    `${root}/node_modules/.bin/effect-tsrs`,
    'diagnostics',
    '-p',
    `${root}/tsconfig.json`,
    '--type-check',
    '--format',
    'json',
  ],
  { cwd: root, stdout: 'pipe', stderr: 'pipe' },
)
const [stdout, stderr, code] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
  child.exited,
])
if (code !== 0 && code !== 1) throw new Error(`Checker did not complete (${code}): ${stderr}`)
const output = Schema.decodeUnknownSync(Schema.fromJsonString(Output))(stdout)
const findings = [...output.typescriptDiagnostics, ...output.diagnostics].filter(
  (item) => item.severity === 'error' || item.severity === 'warning' || item.code === 377000,
)
for (const finding of findings)
  console.error(`${finding.file ?? 'project'}:${finding.line ?? 0} ${finding.name ?? finding.code}: ${finding.message}`)
if (output.summary.filesChecked === 0 || (output.summary.filesWithoutPlugin ?? 0) !== 0)
  throw new Error('Checker coverage is incomplete')
console.log(`effect-tsrs: ${output.summary.filesChecked} files; ${findings.length} findings`)
process.exit(findings.length === 0 && code === 0 ? 0 : 1)
