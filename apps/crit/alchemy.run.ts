/**
 * This project's crit: a stack of its own beside the product's, with one stage (`prod`), so a page never waits for,
 * blocks or breaks a product release. State lives in a store of its own (`<name>-state`), never the account's shared
 * default. Deploy with `bun run deploy`.
 */
import * as Cloudflare from '@alchemy.run/cloudflare'
import * as Alchemy from 'alchemy'
import { site } from './crit.config.ts'
import { resources } from './stack.ts'

export default Alchemy.Stack(
  site.name,
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state({ name: site.name }),
  },
  resources(site),
)
