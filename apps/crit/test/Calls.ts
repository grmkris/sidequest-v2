/** What the journeys ask of a call: the status a request got, and how the API refused one. */
import { ApiError } from '../scripts/client.ts'

export const status = async (url: string, init: RequestInit = {}): Promise<number> =>
  (await fetch(url, { redirect: 'manual', ...init })).status

/** `<status> <error word>` of the refusal, `no error` when the call went through. */
export const refusal = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run
    return 'no error'
  } catch (error) {
    return error instanceof ApiError ? `${error.status} ${error.code}` : 'another error'
  }
}
