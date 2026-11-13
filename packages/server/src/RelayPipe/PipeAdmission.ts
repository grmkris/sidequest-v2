import { type Bucket, fullBucket, takeToken } from './PipePolicy.ts'

/**
 * How many pipes one client address may hold and open. 32 at once: a page reads up to eight default relays and four of
 * an author's own (`maxDefaultRelays`, `maxAuthorRelays`), and a household behind one address has several tabs. 30
 * connects in a burst, refilled at one every two seconds: a page that reconnects every relay after a network change
 * spends twelve. `tracked` bounds the addresses one isolate remembers.
 */
export const admissionLimits = {
  openPerAddress: 32,
  connectBurst: 30,
  connectsPerSecond: 0.5,
  tracked: 10_000,
} as const

export type AdmissionLimits = { readonly [K in keyof typeof admissionLimits]: number }

/** One address's pipes: how many are open, and its connect bucket. */
export interface AddressEntry {
  readonly open: number
  readonly bucket: Bucket
}

/** An address may open a pipe, holds too many already, or opens them too fast. */
export type Admission = 'admitted' | 'tooManyOpen' | 'tooFast'

/** Whether an address may open another pipe at `now`, and its entry afterwards. */
export const admit = (
  entry: AddressEntry | undefined,
  now: number,
  limits: AdmissionLimits,
): { readonly verdict: Admission; readonly entry: AddressEntry } => {
  const current = entry ?? { open: 0, bucket: fullBucket(limits.connectBurst, now) }
  if (current.open >= limits.openPerAddress) return { verdict: 'tooManyOpen', entry: current }
  const take = takeToken(current.bucket, now, limits.connectBurst, limits.connectsPerSecond)
  if (!take.taken) return { verdict: 'tooFast', entry: { ...current, bucket: take.bucket } }
  return { verdict: 'admitted', entry: { open: current.open + 1, bucket: take.bucket } }
}

/**
 * The addresses one isolate has seen, in its memory: a bound per isolate, not per client. Cloudflare runs many isolates
 * in many locations, so a client spread across them (or across addresses) gets the bound in each; see `RelayPipe.ts`.
 * An address with no open pipe is forgotten first when the map is full, which at worst refills its bucket early.
 */
export const makeAdmissions = (limits: AdmissionLimits = admissionLimits) => {
  const entries = new Map<string, AddressEntry>()
  const forgetIdle = () => {
    for (const [address, entry] of entries) {
      if (entries.size < limits.tracked) return
      if (entry.open === 0) entries.delete(address)
    }
  }
  return {
    /** Counts a pipe for `address` if it may open one; `release` must follow once that pipe ends. */
    take: (address: string, now: number) => {
      if (!entries.has(address)) forgetIdle()
      const decided = admit(entries.get(address), now, limits)
      entries.set(address, decided.entry)
      return decided.verdict
    },
    /** One of `address`'s pipes ended. */
    release: (address: string) => {
      const entry = entries.get(address)
      if (entry !== undefined) entries.set(address, { ...entry, open: Math.max(0, entry.open - 1) })
    },
    /** The open pipes counted for `address`, for tests. */
    openFor: (address: string) => entries.get(address)?.open ?? 0,
  }
}

export type Admissions = ReturnType<typeof makeAdmissions>
