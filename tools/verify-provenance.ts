import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Schema } from 'effect'

const Entry = Schema.Struct({ path: Schema.String, sha256: Schema.String })
const Manifest = Schema.Struct({ files: Schema.Array(Entry) })
const root = `${import.meta.dir}/..`
const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(
  await readFile(`${root}/tools/provenance.json`, 'utf8'),
)
for (const file of manifest.files) {
  const actual = createHash('sha256')
    .update(await readFile(`${root}/${file.path}`))
    .digest('hex')
  if (actual !== file.sha256) throw new Error(`Vendored source changed: ${file.path}`)
}
console.log(`Verified ${manifest.files.length} vendored files`)
