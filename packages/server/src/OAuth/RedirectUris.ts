import { Option } from 'effect'

/** The hosts of a loopback redirect, where a native client listens on this device (RFC 8252 §7.3). */
const loopbackHosts: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]', 'localhost'])

/** Schemes that run or read something in the browser instead of handing a code to a client. */
const unsafeSchemes: ReadonlySet<string> = new Set([
  'javascript:',
  'data:',
  'file:',
  'vbscript:',
  'about:',
  'blob:',
  'filesystem:',
  'ws:',
  'wss:',
  'ftp:',
])

/** The longest redirect URI accepted. */
const maxLength = 2000

const parsed = (uri: string): Option.Option<URL> => (URL.canParse(uri) ? Option.some(new URL(uri)) : Option.none())

const isLoopbackUrl = (url: URL) => url.protocol === 'http:' && loopbackHosts.has(url.hostname)

/**
 * Whether a client may name `uri` as a redirect: an absolute URI without a fragment or credentials (RFC 6749 §3.1.2),
 * over HTTPS; or plain HTTP to a loopback address, for a native client on this device (RFC 8252 §7.3); or a private-use
 * scheme for a native app (§7.1, such as `cursor://`). Never a scheme that runs in the browser.
 */
export const isAcceptableRedirect = (uri: string): boolean => {
  if (uri.length > maxLength || uri.includes('#')) return false
  return Option.match(parsed(uri), {
    onNone: () => false,
    onSome: (url) => {
      if (url.username !== '' || url.password !== '') return false
      if (url.protocol === 'https:') return url.hostname !== ''
      if (url.protocol === 'http:') return isLoopbackUrl(url)
      return !unsafeSchemes.has(url.protocol) && /^[a-z][a-z0-9+.-]*:$/u.test(url.protocol)
    },
  })
}

/** Whether two loopback redirects differ at most in their port, which a native client picks when it starts. */
const sameButPort = (registered: string, requested: string) =>
  Option.match(Option.all([parsed(registered), parsed(requested)]), {
    onNone: () => false,
    onSome: ([a, b]) =>
      isLoopbackUrl(a) &&
      isLoopbackUrl(b) &&
      a.hostname === b.hostname &&
      a.pathname === b.pathname &&
      a.search === b.search,
  })

/**
 * Whether `requested` is one of the client's `registered` redirects: the exact string (OAuth 2.1 §2.3.1, no prefix or
 * pattern matching), except that a loopback redirect may name any port (RFC 8252 §7.3).
 */
export const matchesRedirect = (registered: ReadonlyArray<string>, requested: string): boolean =>
  registered.some((uri) => uri === requested || sameButPort(uri, requested))

/** Where a redirect sends the code, as the consent page shows it: its host, or the app's scheme; and whether it is a
 * loopback address on the person's own device. */
export const redirectShown = (uri: string) =>
  Option.match(parsed(uri), {
    onNone: () => ({ host: uri, loopback: false }),
    onSome: (url) => ({ host: url.host === '' ? url.protocol : url.host, loopback: isLoopbackUrl(url) }),
  })

/** `uri` with OAuth response parameters added to its query, keeping the query it already has (RFC 6749 §4.1.2). */
export const withResponse = (uri: string, parameters: Readonly<Record<string, string | null>>) => {
  const url = new URL(uri)
  for (const [name, value] of Object.entries(parameters)) if (value !== null) url.searchParams.set(name, value)
  return url.toString()
}
