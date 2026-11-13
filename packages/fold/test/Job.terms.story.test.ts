import { describe, expect, test } from 'vitest'
import { otherPayment, payment, pub } from './fixtures.ts'
import { fold } from './fold.ts'
import {
  acceptIds,
  conflicting as twoAccepted,
  fundedTwice,
  offered,
  revisionIds,
  rivalFunded,
  strangerOnly,
  superseded as revised,
  unknownTerms,
  withdrawnFunded,
  withdrawnUnfunded,
} from './stories.ts'

const labels = (view: ReturnType<typeof fold>) =>
  view.proposals.map(({ id, superseded, withdrawn, accepted, funded }) => ({
    id,
    superseded,
    withdrawn,
    accepted,
    funded,
  }))

describe('which proposal the chain funded', () => {
  test('funded terms no known proposal offers: funded, terms unknown, no worker, no note counts', () => {
    const view = fold(unknownTerms)
    expect(view.stage).toBe('funded')
    expect(view.worker).toBeNull()
    expect(view.funding).toMatchObject({
      proposal: null,
      terms: 'unknown',
      termsMatchChain: false,
      payerLinked: true,
      receiverLinked: false,
    })
    expect(view.proposals.map((proposal) => proposal.funded)).toEqual([false])
    expect(view.deliveryNotes).toMatchObject([{ author: pub('worker'), fromWorker: false, matchesChain: false }])
  })

  test('a withdrawn proposal leaves the job open, and once funded it is still the funded one', () => {
    const before = fold(withdrawnUnfunded)
    expect(before.stage).toBe('open')
    expect(labels(before)).toEqual([
      { id: offered.event.id, superseded: false, withdrawn: true, accepted: false, funded: false },
    ])
    expect(before.statements).toMatchObject([{ content: { type: 'withdraw_proposal' }, effective: true }])

    const after = fold(withdrawnFunded)
    expect(after.stage).toBe('funded')
    expect(after.worker).toBe(pub('worker'))
    expect(after.funding).toMatchObject({ proposal: offered.event.id, terms: 'known' })
    expect(labels(after)).toEqual([
      { id: offered.event.id, superseded: false, withdrawn: true, accepted: false, funded: true },
    ])
  })

  test('the buyer accepts two bidders: both accepts are labelled conflicting, the job is accepted', () => {
    const view = fold(twoAccepted)
    expect(view.stage).toBe('accepted')
    expect(view.worker).toBeNull()
    expect(view.funding).toBeNull()
    expect(
      view.accepts.map(({ id, fromBuyer, matchesProposal, conflicting }) => [
        id,
        fromBuyer,
        matchesProposal,
        conflicting,
      ]),
    ).toEqual([
      [acceptIds.worker, true, true, true],
      [acceptIds.rival, true, true, true],
      [acceptIds.stranger, false, true, false],
    ])
    expect(view.proposals.map((proposal) => proposal.accepted)).toEqual([true, true])
  })

  test('the chain funds the rival: the receiver decides between proposals with the same terms', () => {
    const view = fold(rivalFunded)
    expect(view.stage).toBe('funded')
    expect(view.worker).toBe(pub('rival'))
    expect(view.funding).toMatchObject({ proposal: acceptIds.rivalOffer, termsAmbiguous: false, receiverLinked: true })
    expect(view.proposals.map((proposal) => [proposal.author, proposal.funded])).toEqual([
      [pub('worker'), false],
      [pub('rival'), true],
    ])
  })

  test('a second payment for the job is listed and ignored: the earliest funding counts', () => {
    const view = fold(fundedTwice)
    expect(view.stage).toBe('funded')
    expect(view.worker).toBe(pub('worker'))
    expect(view.funding).toMatchObject({ fact: { paymentHash: payment }, otherPayments: [otherPayment] })
    expect(view.delivery).toBeNull()
  })

  test('only a stranger accepted: the job is merely proposed', () => {
    const view = fold(strangerOnly)
    expect(view.stage).toBe('proposed')
    expect(view.accepts).toMatchObject([{ fromBuyer: false, conflicting: false }])
    expect(view.proposals.map((proposal) => proposal.accepted)).toEqual([false])
  })

  test('revisions supersede only their own author’s proposals, and a superseded one can still be funded', () => {
    const view = fold(revised)
    const [first, second, third, rival] = revisionIds
    expect(view.stage).toBe('funded')
    expect(view.worker).toBe(pub('worker'))
    expect(view.funding).toMatchObject({ proposal: second, termsAmbiguous: false, termsMatchChain: true })
    expect(labels(view)).toEqual([
      { id: first, superseded: true, withdrawn: false, accepted: false, funded: false },
      { id: second, superseded: true, withdrawn: false, accepted: false, funded: true },
      { id: third, superseded: false, withdrawn: false, accepted: false, funded: false },
      { id: rival, superseded: false, withdrawn: false, accepted: false, funded: false },
    ])
  })
})
