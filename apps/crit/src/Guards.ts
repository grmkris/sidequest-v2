/**
 * What must never be published: files that hold secrets by their name, and text that looks like it holds one. The
 * scripts check before anything leaves the machine (scripts/guards.ts), and the Workers check again at upload and at
 * commit (Publish.ts), so a caller that skips the scripts is held to the same rules.
 */

/** Text files up to this size are read for secrets. */
export const scanBytes = 5 * 1024 * 1024

const deniedSegment = (segment: string): boolean =>
  segment === '.git' ||
  segment === '.wrangler' ||
  segment === '.alchemy' ||
  segment === '.dev.vars' ||
  segment === 'secrets.env' ||
  segment.startsWith('.env') ||
  segment.endsWith('.env') ||
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/u.test(segment) ||
  /\.(pem|key|p12|pfx|sqlite|sqlite3|db)$/u.test(segment)

export const deniedPath = (path: string): boolean => path.split('/').some(deniedSegment)

const secretPatterns: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: 'AWS access key', pattern: /AKIA[0-9A-Z]{16}/u },
  { name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/u },
  { name: 'GitHub token', pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}/u },
  { name: 'API secret key', pattern: /\bsk-(?:ant-|proj-|live_|test_|ws-)?[A-Za-z0-9_-]{24,}/u },
  { name: 'private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
  { name: 'Cloudflare Access secret', pattern: /\bcfast_[A-Za-z0-9_-]{20,}/u },
  { name: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/u },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/u },
  { name: 'crit share link', pattern: /\/s\/[A-Za-z0-9_-]{22}\//u },
]

export const secretsIn = (text: string): ReadonlyArray<string> => [
  ...new Set(secretPatterns.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name)),
]

/** Text by its bytes, whatever the file is called: no NUL in the first 8 kB. So `.ts`, `.yaml` and `.sh` are scanned too. */
export const looksLikeText = (bytes: Uint8Array): boolean => !bytes.subarray(0, 8192).includes(0)

/** What a file's bytes look like they hold; empty for a clean file, a binary one, or one too large to read. */
export const flagsOf = (bytes: Uint8Array): ReadonlyArray<string> =>
  bytes.byteLength <= scanBytes && looksLikeText(bytes) ? secretsIn(new TextDecoder().decode(bytes)) : []
