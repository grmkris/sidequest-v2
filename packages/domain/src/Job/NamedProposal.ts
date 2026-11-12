import { AccountId, Digest, ProposalVersion } from '@sidequest/protocol'
import { Effect } from 'effect'
import { DigestMismatch } from './DigestMismatch.rejection.ts'
import type { Open } from './JobStatus.ts'
import { NoProposal } from './NoProposal.rejection.ts'
import { SupersededVersion } from './SupersededVersion.rejection.ts'

/** How the buyer names one exact proposal version: the bidder, its version and its terms digest. */
export const NamedProposal = { bidder: AccountId, version: ProposalVersion, termsDigest: Digest }

/** Every rejection {@link headNamed} can return. */
export const namedRejections = [NoProposal, SupersededVersion, DigestMismatch] as const

/** The bidder's head proposal, if the buyer named exactly it: its current version and its exact digest. */
export const headNamed = (
  open: typeof Open.Type,
  named: { bidder: AccountId; version: number; termsDigest: Digest },
) => {
  const head = open.heads[named.bidder]
  if (head === undefined) return Effect.fail(new NoProposal({ bidder: named.bidder }))
  if (head.version !== named.version)
    return Effect.fail(new SupersededVersion({ bidder: named.bidder, head: head.version, named: named.version }))
  if (head.termsDigest !== named.termsDigest)
    return Effect.fail(
      new DigestMismatch({
        bidder: named.bidder,
        version: head.version,
        head: head.termsDigest,
        named: named.termsDigest,
      }),
    )
  return Effect.succeed(head)
}
