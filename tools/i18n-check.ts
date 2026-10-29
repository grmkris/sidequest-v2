import { readFile, writeFile } from 'node:fs/promises'
import { format } from 'oxfmt'
import config from '../oxfmt.config.ts'
import { flatten, validateCatalogs } from './i18n/catalog.ts'
import { generate } from './i18n/generate.ts'

const root = `${import.meta.dir}/..`
const load = async (locale: string) => {
  const input: unknown = JSON.parse(await readFile(`${root}/packages/i18n/catalogs/${locale}.json`, 'utf8'))
  return flatten(input)
}
const en = await load('en')
const sl = await load('sl')
const contracts = validateCatalogs(en, sl)
const outputs = generate(en, sl, contracts)
for (const [name, source] of Object.entries(outputs)) {
  const path = `${root}/packages/i18n/src/${name}`
  const result = await format(path, source, config)
  if (result.errors.length) throw new Error(`Cannot format generated ${name}`)
  if (process.argv.includes('--write')) await writeFile(path, result.code)
  else if ((await readFile(path, 'utf8')) !== result.code) throw new Error(`Stale ${name}. Run bun run i18n:generate`)
}
console.log(
  `i18n: ${Object.keys(en).length} messages; ICU, variables, tags, plural coverage and generated files verified`,
)
