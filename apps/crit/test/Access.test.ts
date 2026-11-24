import { Option } from 'effect'
import { beforeAll, describe, expect, it } from 'vitest'
import { admittedEmail } from '../src/Access.ts'
import { addressOf, publicAddressOf, sharedAddressOf } from '../src/Files.ts'
import { reservedSlugs } from '../src/Model.ts'
import { makeSigner, type Signer } from './AccessTokens.ts'

const aud = 'a'.repeat(64)
const team = 'https://example.cloudflareaccess.com'
const now = 1_800_000_000

let ours: Signer
let theirs: Signer
beforeAll(async () => {
  ours = await makeSigner('ours')
  theirs = await makeSigner('ours')
})

type Guard = Parameters<typeof admittedEmail>[1]
const envWith = (jwks: string, over: Guard = {}): Guard => ({
  ACCESS_AUD: aud,
  ACCESS_TEAM: team,
  ACCESS_JWKS: jwks,
  ...over,
})

const asked = (token: string | undefined, origin: string) =>
  new Request(`${origin}/`, token === undefined ? {} : { headers: { 'cf-access-jwt-assertion': token } })

const admitted = async (token: string | undefined, env: Guard = envWith(ours.jwks), origin = 'http://localhost:8787') =>
  Option.getOrUndefined(await admittedEmail(asked(token, origin), env, now))

describe('the Access token check', () => {
  it('admits the email of a token signed for this application, lower-cased', async () => {
    const token = await ours.sign({ email: 'Mira@Example.com', aud, iss: team, exp: now + 60 })
    expect(await admitted(token)).toBe('mira@example.com')
  })

  it('refuses no token, a token for another application, another issuer, and an expired one', async () => {
    expect(await admitted(undefined)).toBeUndefined()
    expect(await admitted('not.a.token')).toBeUndefined()
    const good = { email: 'mira@example.com', aud, iss: team, exp: now + 60 }
    expect(await admitted(await ours.sign({ ...good, aud: 'b'.repeat(64) }))).toBeUndefined()
    expect(await admitted(await ours.sign({ ...good, iss: 'https://other.cloudflareaccess.com' }))).toBeUndefined()
    expect(await admitted(await ours.sign({ ...good, exp: now - 1 }))).toBeUndefined()
  })

  it('refuses a token signed by another key under the same key id, and a tampered one', async () => {
    const good = { email: 'mira@example.com', aud, iss: team, exp: now + 60 }
    expect(await admitted(await theirs.sign(good))).toBeUndefined()
    const [head, , signature] = (await ours.sign(good)).split('.')
    const forged = btoa(JSON.stringify({ aud: [aud], iss: team, exp: now + 60, email: 'eve@example.com' }))
    expect(await admitted(`${head}.${forged.replace(/=+$/u, '')}.${signature}`)).toBeUndefined()
  })

  it('takes keys from a binding only on this machine: a deployed host ignores them', async () => {
    const token = await ours.sign({ email: 'mira@example.com', aud, iss: 'http://127.0.0.1:9', exp: now + 60 })
    const env = envWith(ours.jwks, { ACCESS_TEAM: 'http://127.0.0.1:9' })
    expect(await admitted(token, env)).toBe('mira@example.com')
    expect(await admitted(token, env, 'https://team.example.com')).toBeUndefined()
  })

  it('admits nobody on a site without Access, or whose keys cannot be read', async () => {
    const token = await ours.sign({ email: 'mira@example.com', aud, iss: team, exp: now + 60 })
    expect(await admitted(token, envWith(ours.jwks, { ACCESS_AUD: '' }))).toBeUndefined()
    expect(await admitted(token, envWith(ours.jwks, { ACCESS_TEAM: '' }))).toBeUndefined()
    expect(await admitted(token, envWith('{"keys":"nonsense"}'))).toBeUndefined()
  })
})

describe('addresses on the one host', () => {
  it('reads a public page under /p/ and nothing from /p alone', () => {
    expect(publicAddressOf('/p/spike/')).toEqual({ slug: 'spike', path: '' })
    expect(publicAddressOf('/p/spike/media/film.mp4')).toEqual({ slug: 'spike', path: 'media/film.mp4' })
    expect(publicAddressOf('/p/spike')).toEqual({ slug: 'spike', path: undefined })
    expect(publicAddressOf('/p/')).toBeUndefined()
    expect(publicAddressOf('/p')).toBeUndefined()
    expect(publicAddressOf('/pfoo/')).toBeUndefined()
  })

  it("keeps crit's own first segments out of page names", () => {
    expect(reservedSlugs).toEqual(['p', 's', 'api', 'mcp', 'lib', '_crit', 'cdn-cgi'])
    // They are valid as addresses, which is why a publish under one of them must be refused.
    for (const name of reservedSlugs) expect(addressOf(`/${name}/`)?.slug).toBe(name)
    expect(sharedAddressOf(`/s/${'t'.repeat(22)}/spike/`)?.address.slug).toBe('spike')
  })
})
