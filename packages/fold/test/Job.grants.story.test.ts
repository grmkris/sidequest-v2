import { describe, expect, test } from 'vitest'
import { at, grantFact, hour, pub } from './fixtures.ts'
import { fold } from './fold.ts'
import {
  acceptUnder,
  agentAccept,
  agentNote,
  agentOffer,
  agentsAgree,
  agentsFunded,
  buyerGrant,
  buyerGrantId,
  grantStories,
  meddling,
  ownNoteId,
  strangerGrant,
  workerGrant,
  workerGrantId,
} from './grantStories.ts'

const acceptOf = (view: ReturnType<typeof fold>) => view.accepts.find(({ id }) => id === agentAccept.parsed.event.id)

describe('an agent’s event counts as its operator’s under their grant', () => {
  test('the worker’s agent proposes and the buyer’s agent accepts: accepted, each labelled as its operator’s', () => {
    const view = fold(agentsAgree)
    expect(view.stage).toBe('accepted')
    expect(view.proposals).toMatchObject([
      {
        author: pub('agent'),
        by: 'agent',
        operator: pub('worker'),
        grant: workerGrantId,
        grantRefusal: null,
        accepted: true,
      },
    ])
    expect(acceptOf(view)).toMatchObject({
      author: pub('buyerAgent'),
      by: 'agent',
      operator: pub('buyer'),
      grant: buyerGrantId,
      fromBuyer: true,
      matchesProposal: true,
    })
  })

  // Each rule broken on its own: the accept is then its signer's own, a signal that is not the buyer's.
  test.each([
    ['no such grant is known', undefined, 'unknownGrant'],
    ['the grant is for another key', grantFact('b1', 'buyer', 'agent', ['accept'])(), 'otherKey'],
    ['the grant lacks the accept scope', grantFact('b1', 'buyer', 'buyerAgent', ['discuss'])(), 'scopeMissing'],
    ['the accept was signed before the window', buyerGrant({ notBefore: at(2 * hour + 1) }), 'outsideWindow'],
    ['the accept was signed at the window’s end', buyerGrant({ expiresAt: at(2 * hour) }), 'outsideWindow'],
    ['the buyer revoked the grant', buyerGrant({ revoked: true }), 'revoked'],
  ] as const)('%s: not the buyer’s accept (%s)', (_, grant, refusal) => {
    const view = fold(acceptUnder(grant))
    expect(view.stage).toBe('proposed')
    expect(acceptOf(view)).toMatchObject({ by: 'self', operator: null, grant: buyerGrantId, grantRefusal: refusal })
    expect(acceptOf(view)?.fromBuyer).toBe(false)
    expect(view.proposals.map((offer) => offer.accepted)).toEqual([false])
  })

  test('a grant by someone other than the buyer makes the accept that person’s, not the buyer’s', () => {
    const view = fold(acceptUnder(grantFact('b1', 'stranger', 'buyerAgent', ['accept'])()))
    expect(view.stage).toBe('proposed')
    expect(acceptOf(view)).toMatchObject({ by: 'agent', operator: pub('stranger'), fromBuyer: false })
  })

  test('the worker withdraws their agent’s proposal; a stranger under a grant without propose cannot', () => {
    const view = fold(grantStories.withdrawnByOperator)
    expect(view.stage).toBe('open')
    expect(view.proposals.map((offer) => offer.withdrawn)).toEqual([true])
    const said = view.statements.find(({ id }) => id === meddling.parsed.event.id)
    expect(said).toMatchObject({ effective: false, grantRefusal: 'scopeMissing' })
    expect(strangerGrant().operator).toBe(pub('worker'))
  })

  test('the worker’s own revision supersedes their agent’s proposal', () => {
    const view = fold(grantStories.revisedByOperator)
    expect(view.proposals.map(({ author, superseded }) => [author, superseded])).toEqual([
      [pub('agent'), true],
      [pub('worker'), false],
    ])
  })

  test('the buyer’s agent closes the request under the accept scope', () => {
    const view = fold(grantStories.closedByAgent)
    expect(view.stage).toBe('closed')
    expect(view.request.closedByBuyer).toBe(true)
    expect(view.statements).toMatchObject([{ by: 'agent', operator: pub('buyer'), effective: true }])
  })
})

describe('funding an agent’s proposal pays its operator, who is the worker', () => {
  test('the operator is the worker; their wallet is the linked receiver; both their notes and their agent’s count', () => {
    const view = fold(agentsFunded([workerGrant(), buyerGrant()]))
    expect(view.stage).toBe('funded')
    expect(view.worker).toBe(pub('worker'))
    expect(view.funding).toMatchObject({ proposal: agentOffer.parsed.event.id, receiverLinked: true })
    expect(view.deliveryNotes.map(({ id, fromWorker, by }) => [id, fromWorker, by])).toEqual([
      [ownNoteId, true, 'self'],
      [agentNote.parsed.event.id, true, 'agent'],
    ])
  })

  test('a note by the agent without the deliver scope is not the worker’s', () => {
    const proposeOnly = grantFact('a1', 'worker', 'agent', ['propose'])()
    const view = fold(agentsFunded([proposeOnly, buyerGrant()]))
    expect(view.worker).toBe(pub('worker'))
    expect(view.deliveryNotes.find(({ id }) => id === agentNote.parsed.event.id)).toMatchObject({
      fromWorker: false,
      grantRefusal: 'scopeMissing',
    })
  })
})

describe('a revocation authorises nothing, whenever it arrived; the chain’s money is never undone', () => {
  test('the buyer’s agent accepted, then the buyer revoked: the accept stops counting, the job is proposed again', () => {
    const view = fold(grantStories.acceptSeenBeforeAndAfterRevocation)
    expect(view.stage).toBe('proposed')
    expect(acceptOf(view)).toMatchObject({ fromBuyer: false, grantRefusal: 'revoked' })
  })

  test('revoked after funding: the operator stays the worker and paid party; the agent’s later word stops counting', () => {
    const view = fold(grantStories.fundedThenRevoked)
    expect(view.stage).toBe('funded')
    expect(view.worker).toBe(pub('worker'))
    expect(view.funding?.receiverLinked).toBe(true)
    expect(view.proposals).toMatchObject([{ by: 'agent', operator: pub('worker'), funded: true, grantRefusal: null }])
    expect(view.deliveryNotes.map(({ fromWorker, grantRefusal }) => [fromWorker, grantRefusal])).toEqual([
      [true, null],
      [false, 'revoked'],
    ])
  })

  test('revoked before funding: the agent’s proposal is its own key’s, no longer its operator’s offer', () => {
    const revoked = fold({ ...agentsAgree, grants: [workerGrant({ revoked: true }), buyerGrant()] })
    expect(revoked.proposals).toMatchObject([{ by: 'self', operator: null, grantRefusal: 'revoked' }])
  })
})
