import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import { Status } from './Status.ts'

export class SystemApi extends HttpApiGroup.make('system').add(
  HttpApiEndpoint.get('status', '/api/status', { success: Status }),
) {}

export class SidequestApi extends HttpApi.make('sidequest').add(SystemApi) {}
