/**
 * The Cloudflare account pair for `deploy`, from the mode-600 file `site.credentials` names. It refuses a file for
 * another account, so a deploy can never land in the wrong one.
 */
import { site } from '../crit.config.ts'
import { readSecrets, secretFile } from './secrets.ts'

export const accountPair = (): Readonly<Record<'CLOUDFLARE_API_TOKEN' | 'CLOUDFLARE_ACCOUNT_ID', string>> => {
  const values = readSecrets(site.credentials)
  const token = values.get('CLOUDFLARE_API_TOKEN') ?? ''
  const account = values.get('CLOUDFLARE_ACCOUNT_ID') ?? ''
  const file = secretFile(site.credentials)
  if (account !== site.account) throw new Error(`${file} must name the account in crit.config.ts`)
  if (token === '') throw new Error(`${file} holds no CLOUDFLARE_API_TOKEN`)
  return { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account }
}
