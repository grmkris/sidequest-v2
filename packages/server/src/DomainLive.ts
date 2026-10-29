import * as DomainCloudflare from '@alchemy.run/cloudflare/Domain'
import { Sidequest } from '@sidequest/domain'
import { Layer } from 'effect'

export const DomainLive = Sidequest.layer(Layer.empty).pipe(Layer.provide(DomainCloudflare.DurableObjects))
