/**
 * The scripts' side of the agents' API (src/Api.ts). crit's address and the publish token come from the
 * environment (`CRIT_URL`, `CRIT_PUBLISH_TOKEN`) or from the mode-600 file `site.publishEnv` names, so an agent
 * publishes without ever holding the Cloudflare account's token.
 */
import { Data, Option, Schema } from 'effect'
import { site } from '../crit.config.ts'
import { ErrorBody } from '../src/Model.ts'
import { readSecrets } from './secrets.ts'

export interface Instance {
  readonly url: string
  readonly token: string
}

export const instance = (): Instance => {
  const file = readSecrets(site.publishEnv)
  const ownHost = site.domain === undefined ? '' : `https://${site.domain.host}`
  const url = process.env['CRIT_URL'] ?? file.get('CRIT_URL') ?? ownHost
  const token = process.env['CRIT_PUBLISH_TOKEN'] ?? file.get('CRIT_PUBLISH_TOKEN') ?? ''
  if (url === '') throw new Error(`No address for crit: set CRIT_URL in ${site.publishEnv} (the Worker's address)`)
  if (token === '') throw new Error(`No publish token: set CRIT_PUBLISH_TOKEN in ${site.publishEnv}`)
  return { url: url.replace(/\/+$/u, ''), token }
}

/** crit refused the call: the status and its `error` word (`blobs_missing`, `sharing_is_off`, …). */
export class ApiError extends Data.TaggedError('ApiError')<{
  readonly status: number
  readonly code: string
  readonly message: string
}> {}

const refused = (status: number, code: string): ApiError =>
  new ApiError({ status, code, message: `crit answered ${status} ${code}` })

const decodeError = Schema.decodeUnknownOption(ErrorBody)

const failure = async (response: Response): Promise<ApiError> => {
  const body: unknown = await response.json().catch(() => undefined)
  return refused(response.status, Option.getOrUndefined(decodeError(body))?.error ?? 'unknown')
}

export interface Call {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  readonly path: string
  readonly json?: unknown
  readonly bytes?: Uint8Array<ArrayBuffer>
  readonly headers?: Readonly<Record<string, string>>
}

/** A GET answered as text (the comments as Markdown), or an `ApiError`. */
export const read = async (to: Instance, path: string, accept: string): Promise<string> => {
  const response = await fetch(`${to.url}${path}`, { headers: { authorization: `Bearer ${to.token}`, accept } })
  if (!response.ok) throw await failure(response)
  return response.text()
}

/** One call; the JSON answer (undefined for an empty one) or an `ApiError`. */
export const call = async (to: Instance, request: Call): Promise<unknown> => {
  const body = request.bytes ?? (request.json === undefined ? undefined : JSON.stringify(request.json))
  const response = await fetch(`${to.url}${request.path}`, {
    method: request.method,
    headers: {
      authorization: `Bearer ${to.token}`,
      ...(request.json === undefined ? {} : { 'content-type': 'application/json' }),
      ...(request.bytes === undefined ? {} : { 'content-type': 'application/octet-stream' }),
      ...request.headers,
    },
    ...(body === undefined ? {} : { body }),
  })
  if (!response.ok) throw await failure(response)
  const answer = await response.text()
  const parsed: unknown = answer === '' ? undefined : JSON.parse(answer)
  return parsed
}
