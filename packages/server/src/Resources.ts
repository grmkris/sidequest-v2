import * as Cloudflare from '@alchemy.run/cloudflare'

export const SidequestDatabase = Cloudflare.D1.Database('SidequestV2Database', {
  migrations: 'packages/db/migrations',
})

export const SidequestMedia = Cloudflare.R2.Bucket('SidequestV2Media', { jurisdiction: 'eu' })
