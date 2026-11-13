import { ServedApi } from '@sidequest/fold/api'
import * as HttpApiClient from 'effect/http-api/HttpApiClient'

/** The typed client, built from the API's own declaration. Loaded on first use, so its schemas stay out of the code a
 * page needs before it hydrates. */
export const makeApi = (origin: string) => HttpApiClient.make(ServedApi, { baseUrl: origin })
