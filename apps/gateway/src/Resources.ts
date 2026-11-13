import * as Cloudflare from '@alchemy.run/cloudflare'

/** The gateway's own database: agents' sealed keys, OAuth, replay guards and rate limits. Never the core's. */
export const GatewayDatabase = Cloudflare.D1.Database('SidequestGatewayDatabase', {
  migrations: 'apps/gateway/migrations',
})
