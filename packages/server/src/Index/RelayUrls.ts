import { Option } from 'effect'

/**
 * Which relay URLs the index and the edge's relay pipe may connect to. `public`, always outside tests: `wss` on port
 * 443 to a public host name, never an IP literal, `localhost` or a name only a private network resolves. `local` is for
 * tests alone: it also allows a relay on `ws://127.0.0.1`, as the test relay listens there. Relays the index learns
 * from people's lists, and relays a browser asks the pipe for, meet the same rule, so neither can point a Worker at
 * anything else.
 */
export type RelayUrlPolicy = 'public' | 'local'

// A DNS name of labels ending in an alphabetic top-level label, so `10.0.0.1` and `[::1]` are not names.
const publicHostName = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u
const privateSuffixes = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.test', '.invalid', '.example']

const isPublicHost = (host: string) =>
  publicHostName.test(host) && !privateSuffixes.some((suffix) => host.endsWith(suffix))

const isLocalTestRelay = (url: URL) => url.protocol === 'ws:' && url.hostname === '127.0.0.1'

const parsed = (text: string) => (URL.canParse(text) ? Option.some(new URL(text)) : Option.none())

/** The relay URL in its normal spelling, if `policy` allows it; the URL standard lowercases the host. */
export const relayUrlOf = (text: string, policy: RelayUrlPolicy): Option.Option<string> =>
  Option.flatMap(parsed(text.trim()), (url) => {
    const bare = url.username === '' && url.password === '' && url.hash === ''
    // The URL standard drops a scheme's default port, so `wss://host:443` reads as no port, and any other is refused.
    const publicRelay = url.protocol === 'wss:' && url.port === '' && isPublicHost(url.hostname)
    const allowed = publicRelay || (policy === 'local' && isLocalTestRelay(url))
    return bare && allowed ? Option.some(url.href) : Option.none()
  })

/** Each allowed URL once, in order, at most `limit` of them. */
export const allowedRelays = (
  urls: ReadonlyArray<string>,
  policy: RelayUrlPolicy,
  limit: number,
): ReadonlyArray<string> => [...new Set(urls.flatMap((url) => Option.toArray(relayUrlOf(url, policy))))].slice(0, limit)
