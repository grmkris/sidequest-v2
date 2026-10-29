import * as AuthClient from '@yielded/auth/Client'
import { Context, type Effect, Layer } from 'effect'

import { AuthApi } from './config.ts'

/** Browser-safe transport definition. It owns one scoped credential lifetime;
 * callers should provide the layer for the lifetime of their Foldkit host. */
export const makeAuthClient = (baseUrl: string) =>
  AuthClient.make(AuthApi, {
    baseUrl,
    csrf: { header: 'x-effect-auth-csrf', value: '1' },
  })

export const authClientLayer = (baseUrl: string) => makeAuthClient(baseUrl).layerFetch

export class BrowserAuth extends Context.Service<
  BrowserAuth,
  Effect.Success<ReturnType<typeof makeAuthClient>['make']>
>()('@sidequest/auth/BrowserAuth') {}

/** One client lifetime for the browser host; the trusted URL is supplied by its entrypoint. */
export const browserAuthLayer = (baseUrl: string) => {
  const definition = makeAuthClient(baseUrl)
  return Layer.effect(BrowserAuth, definition).pipe(Layer.provide(definition.layerFetch))
}
