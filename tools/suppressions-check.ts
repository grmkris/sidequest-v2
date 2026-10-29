import { readFile } from 'node:fs/promises'
import { Schema } from 'effect'
import { Visitor } from 'oxc-parser'
import { readSource, sourceFiles } from './quality/source.ts'

const Budget = Schema.Array(Schema.Struct({ file: Schema.String, comment: Schema.String }))
const baseline = Schema.decodeUnknownSync(Schema.fromJsonString(Budget))(
  await readFile('tools/suppressions.json', 'utf8'),
)
const observed: (typeof Budget.Type)[number][] = []
for (const file of await sourceFiles()) {
  const { parsed } = await readSource(file)
  new Visitor({
    TSNonNullExpression: () => {
      throw new Error(`Non-null assertion in ${file}; use a guard`)
    },
    TSAnyKeyword: () => {
      throw new Error(`Explicit any in ${file}; decode or narrow unknown`)
    },
  }).visit(parsed.program)
  for (const { value } of parsed.comments) {
    const comment = value.trim()
    if (/(?:oxlint|eslint)-disable|@effect-diagnostics|@ts-(?:ignore|expect-error|nocheck)|SAFETY:/.test(comment)) {
      if (!comment.includes(' -- ') || (comment.split(' -- ')[1]?.length ?? 0) < 20)
        throw new Error(`Suppression needs a specific reason in ${file}: ${comment}`)
      observed.push({ file, comment })
    }
  }
}
const canonical = (entries: typeof Budget.Type) =>
  entries
    .map((entry) => JSON.stringify(entry))
    .toSorted()
    .join('\n')
if (canonical(observed) !== canonical(baseline))
  throw new Error('Suppression census changed; review exact additions/removals in tools/suppressions.json')
console.log(`Suppression census: ${observed.length} reviewed directives; no explicit any or non-null assertions`)
