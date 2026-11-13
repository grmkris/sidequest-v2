import { readFileSync } from 'node:fs'

// The ERC-8004 text at ethereum/ERCs 503591a, vendored byte for byte (`tools/provenance.json`), read as tests need it:
// its fenced JSON examples with the comments the spec writes in them removed.

const spec = readFileSync(new URL('vectors/erc-8004.md', import.meta.url), 'utf8')

const fenced = (language: string): ReadonlyArray<string> =>
  [...spec.matchAll(new RegExp(`\`\`\`${language}\\n([\\s\\S]*?)\`\`\``, 'gu'))].map((match) => match[1] ?? '')

/** A `jsonc` block as JSON: line comments dropped (none of the spec's strings holds `//` but its URLs, kept). */
const jsonOf = (block: string): unknown =>
  JSON.parse(
    block
      .split('\n')
      .map((line) => line.replace(/\s\/\/(?!\/).*$/u, ''))
      .filter((line) => !line.includes('" ... "'))
      .join('\n')
      .replace(/,(\s*[}\]])/gu, '$1'),
  )

/** The spec's JSON examples in order: the agent registration file, then the off-chain feedback file. */
export const specExamples = fenced('jsonc').map(jsonOf)
