import { UsdcOnArcTestnet } from '@sidequest/protocol'
import { Option } from 'effect'
import { Command, click, expect, given, role, scene, text, withViewInputs } from 'foldkit/scene'
import { describe, test } from 'vitest'
import { Me, Standing } from '../../../src/Me.ts'
import { init, Message, PublishAccept, ReadJob, update } from '../../../src/page/job/Job.ts'
import { view } from '../../../src/page/job/JobPage.ts'
import { Preload } from '../../../src/Preload.ts'
import { bidderKey, buyerKey, foldedJob, now, otherKey, proposalFrom, requestId } from '../../Fixtures.ts'

const agent = 'a9'.repeat(32)
const proposal = proposalFrom(bidderKey, 'e1', '250000000')

/** An accept of the proposal signed by `author`, as the fold judged it: by default not the buyer's, because the grant
 * it named lacks the `accept` scope. */
const acceptBy = (
  author: string,
  judged: Record<string, unknown> = { grant: 'ab'.repeat(32), grantRefusal: 'scopeMissing' },
) => ({
  id: 'ac'.repeat(32),
  author,
  createdAt: now + 120,
  proposal: proposal.id,
  worker: bidderKey,
  fromBuyer: false,
  matchesProposal: true,
  conflicting: false,
  ...judged,
})

const buyerWithAgent = Me.Ready({
  identity: { signerKind: 'nip07', pubkey: buyerKey },
  standing: Standing.Known({ maybeName: Option.none(), wallets: [], agents: [{ pubkey: agent, label: 'Scout' }] }),
})

const opened = (accept: ReturnType<typeof acceptBy>, me = buyerWithAgent, accepted = false) =>
  init(
    'en',
    requestId,
    me,
    Option.some(
      Preload.Job({
        view: foldedJob({
          stage: accepted ? 'accepted' : 'proposed',
          proposals: [{ ...proposal, accepted }],
          accepts: [accept],
        }),
        names: [],
      }),
    ),
  ).model

const page = withViewInputs(view, { timeZone: 'UTC', inboxConfigured: false })

describe('an accept by the buyer’s agent', () => {
  test('shows as the agent’s suggestion, and one click publishes the buyer’s own accept', () => {
    scene(
      { update, view: page() },
      given(opened(acceptBy(agent))),
      expect(text('Your agent Scout suggests accepting this proposal.')).toExist(),
      expect(
        text('Its grant does not let it accept for you, so its accept is only a suggestion until you accept yourself.'),
      ).toExist(),
      click(role('button', { name: 'Accept as suggested' })),
      Command.expectExact(
        PublishAccept({
          job: requestId,
          proposal: proposal.id,
          termsDigest: proposal.content.termsDigest,
          worker: bidderKey,
          network: UsdcOnArcTestnet.network,
        }),
      ),
      Command.resolve(PublishAccept, Message.SucceededPublish({ act: 'accept' })),
      Command.resolve(ReadJob({ job: requestId, fresh: true }), Message.SucceededReadJob({ view: foldedJob() })),
    )
  })

  test('is no suggestion when a key the buyer did not grant signed it, or to anyone but the buyer', () => {
    scene(
      { update, view: page() },
      given(opened(acceptBy(otherKey))),
      expect(text('Your agent Scout suggests accepting this proposal.')).not.toExist(),
    )
    const bidder = Me.Ready({
      identity: { signerKind: 'nip07', pubkey: bidderKey },
      standing: Standing.Known({ maybeName: Option.none(), wallets: [], agents: [{ pubkey: agent, label: 'Scout' }] }),
    })
    scene(
      { update, view: page() },
      given(opened(acceptBy(agent), bidder)),
      expect(text('Your agent Scout suggests accepting this proposal.')).not.toExist(),
    )
  })

  test('an accept under the buyer’s grant counts as the buyer’s: shown accepted by their agent, never as a suggestion', () => {
    const counted = acceptBy(agent, { by: 'agent', operator: buyerKey, grant: 'ab'.repeat(32), fromBuyer: true })
    scene(
      { update, view: page() },
      given(opened(counted, buyerWithAgent, true)),
      expect(text('Accepted by your agent Scout, under your grant.')).toExist(),
      expect(text('Your agent Scout suggests accepting this proposal.')).not.toExist(),
      expect(role('button', { name: 'Accept as suggested' })).not.toExist(),
    )
  })
})
