import { SidequestApi } from '@sidequest/protocol'
import { Layer } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import { sessionHandlers } from './SignIn/SessionHttp.ts'
import { systemHandlers } from './Status.ts'

/** The typed HTTP API's routes: every group of `SidequestApi` with its handlers. */
export const apiRoutes = (release: string) =>
  HttpApiBuilder.layer(SidequestApi).pipe(Layer.provide([systemHandlers(release), sessionHandlers]))
