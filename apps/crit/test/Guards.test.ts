import { describe, expect, it } from 'vitest'
import { contentTypeOf } from '../src/ContentType.ts'
import { parseArgs } from '../scripts/args.ts'
import { check, type PageFile } from '../scripts/guards.ts'
import { deniedPath, flagsOf, looksLikeText, secretsIn } from '../src/Guards.ts'
import { amountOf } from '../src/Time.ts'
import { isToken, randomToken, sha256Hex, tokenHash } from '../src/Crypto.ts'

const file = (path: string, text: string): PageFile => ({
  path,
  bytes: new TextEncoder().encode(text),
  contentType: contentTypeOf(path),
})

describe('files that are never published', () => {
  it('refuses secrets files, keys, databases and tool folders, wherever they sit', () => {
    for (const path of [
      '.env',
      '.env.local',
      'prod.env',
      'a/.git/config',
      'keys/id_ed25519',
      'x/cert.pem',
      'data.sqlite',
      '.dev.vars',
    ]) {
      expect({ path, denied: deniedPath(path) }).toEqual({ path, denied: true })
    }
  })

  it('lets ordinary page files through', () => {
    for (const path of ['index.html', 'shots/a.webp', 'media/v1.mp4', 'environment.html', 'notes/keys.md']) {
      expect({ path, denied: deniedPath(path) }).toEqual({ path, denied: false })
    }
  })
})

describe('secrets inside files', () => {
  it('names what a text holds', () => {
    expect(secretsIn(`key = "AKIA${'A'.repeat(16)}"`)).toEqual(['AWS access key'])
    expect(secretsIn(`ghp_${'a'.repeat(36)} and -----BEGIN RSA PRIVATE KEY-----`)).toEqual([
      'GitHub token',
      'private key',
    ])
    expect(secretsIn(`https://share.example.com/s/${'A'.repeat(22)}/spike/`)).toEqual(['crit share link'])
    expect(secretsIn('<h1>Plain page</h1> sk-not-long')).toEqual([])
  })

  it('scans a file with an unknown extension when its bytes are text', () => {
    expect(check([file('run.sh', `export TOKEN=ghp_${'a'.repeat(36)}`)])).toEqual([
      'run.sh: looks like it holds a GitHub token',
    ])
    expect(looksLikeText(new Uint8Array([137, 80, 78, 71, 0, 0]))).toBe(false)
  })
})

describe('the whole page', () => {
  it('passes a clean page and reports every problem of a bad one', () => {
    expect(check([file('index.html', '<h1>Fine</h1>')])).toEqual([])
    expect(check([])).toEqual(['the page folder is empty'])
    expect(check([file('index.html', 'ok'), file('.env', 'A=1')])).toEqual([
      '.env: this kind of file is never published',
    ])
  })
})

describe('tokens and hashes', () => {
  it('hashes as SHA-256 and makes 128-bit tokens stored only by hash', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    const token = randomToken()
    expect(isToken(token)).toBe(true)
    expect(randomToken()).not.toBe(token)
    expect(await tokenHash(token)).toMatch(/^[0-9a-f]{64}$/u)
    expect(await tokenHash(token)).not.toBe(await sha256Hex(token))
  })
})

describe('what the server keeps about a file', () => {
  it('flags a text file that looks like it holds a secret, and lets `--allow-secrets` past the script only', () => {
    const leaky = file('notes.txt', `token ghp_${'a'.repeat(36)}`)
    expect(flagsOf(leaky.bytes)).toEqual(['GitHub token'])
    expect(flagsOf(new TextEncoder().encode('<h1>Fine</h1>'))).toEqual([])
    expect(flagsOf(new Uint8Array([0, 1, 2, 3]))).toEqual([])
    expect(check([leaky])).toHaveLength(1)
    expect(check([leaky], { allowSecrets: true })).toEqual([])
    // A denied file stays denied whatever is allowed.
    expect(check([file('.env', 'A=1')], { allowSecrets: true })).toHaveLength(1)
  })

  it('reads a number of days or hours from a binding, and nothing else', () => {
    expect(amountOf('14')).toBe(14)
    expect(amountOf('0.5')).toBe(0.5)
    for (const value of [undefined, '', ' ', 'soon', '-3']) expect(amountOf(value)).toBe(0)
    expect(amountOf(undefined, 24)).toBe(24)
    expect(amountOf('0', 24)).toBe(0)
  })
})

describe('a command line', () => {
  it('keeps words, bare flags and valued flags apart, wherever the flags sit', () => {
    expect(parseArgs(['demo'], ['--days'])).toEqual({ words: ['demo'], flags: new Set(), values: new Map() })
    const mixed = parseArgs(['--revoke', 'demo', '--days', '7', 'other'], ['--days'])
    expect(mixed.words).toEqual(['demo', 'other'])
    expect([...mixed.flags]).toEqual(['--revoke'])
    expect(mixed.values.get('--days')).toBe('7')
    expect(parseArgs(['plan', '--from'], ['--from']).values.get('--from')).toBe('')
    expect(parseArgs(['reply', 'id', 'the text', '--as', 'claude'], ['--as']).words).toEqual([
      'reply',
      'id',
      'the text',
    ])
  })
})
