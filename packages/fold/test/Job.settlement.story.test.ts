import { describe, expect, test } from 'vitest'
import { at, day, deliveryHash, payment, pub } from './fixtures.ts'
import { fold } from './fold.ts'
import { disputed, expiring, job, offered, overdue, paid, paidIds, reclaimedJob, refunded, ruled } from './stories.ts'

const closedDeadlines = { deliveryOverdue: false, reviewWindowOpen: false, arbitrationOpen: false, reclaimable: false }

describe('a job settles only through chain facts', () => {
  test('delivered, approved and paid: both parties linked, the note matches, both reviews count', () => {
    const view = fold(paid)
    expect(view.job).toBe(job)
    expect(view.stage).toBe('released')
    expect(view.buyer).toBe(pub('buyer'))
    expect(view.worker).toBe(pub('worker'))
    expect(view.funding).toMatchObject({
      proposal: offered.event.id,
      terms: 'known',
      termsAmbiguous: false,
      termsMatchChain: true,
      payerLinked: true,
      receiverLinked: true,
      otherPayments: [],
    })
    expect(view.proposals.map((proposal) => [proposal.id, proposal.accepted, proposal.funded])).toEqual([
      [offered.event.id, true, true],
    ])
    expect(view.delivery).toMatchObject({ deliveryHash, deliveredAt: at(5 * day) })
    expect(view.ending).toMatchObject({ _tag: 'Settled', outcome: 'Approved', workerShareBps: 10_000 })
    expect(view.deadlines).toEqual(closedDeadlines)
    expect(view.deliveryNotes).toMatchObject([{ id: paidIds.note, fromWorker: true, matchesChain: true }])
    expect(view.reviews.map((review) => [review.author, review.side, review.status])).toEqual([
      [pub('buyer'), 'payer', 'counted'],
      [pub('worker'), 'receiver', 'counted'],
    ])
  })

  test('rejected inside the review window, then split 60/40 by the arbitrator', () => {
    const during = fold(disputed)
    expect(during.stage).toBe('rejected')
    expect(during.deadlines).toEqual({ ...closedDeadlines, arbitrationOpen: true })
    expect(during.statements).toMatchObject([{ content: { type: 'rejection_reason' }, effective: true }])
    expect(during.reviews).toEqual([])

    const after = fold(ruled)
    expect(after.stage).toBe('ruled')
    expect(after.rejection).toMatchObject({ rejectedAt: at(5 * day + 3_600) })
    expect(after.ending).toMatchObject({
      outcome: 'Ruled',
      workerShareBps: 6_000,
      capturedAmount: '72000000',
      feeAmount: '3600000',
      refundedAmount: '48000000',
    })
    expect(after.deadlines).toEqual(closedDeadlines)
  })

  test('never delivered: overdue is a label on a funded job until the refund lands', () => {
    const late = fold(overdue)
    expect(late.stage).toBe('funded')
    expect(late.deadlines).toEqual({ ...closedDeadlines, deliveryOverdue: true })
    expect(late.delivery).toBeNull()

    const back = fold(refunded)
    expect(back.stage).toBe('refunded')
    expect(back.ending).toMatchObject({ outcome: 'Undelivered', workerShareBps: 0, refundedAmount: '120000000' })
    expect(back.deadlines).toEqual(closedDeadlines)
  })

  test('the escrow expires on a delivered job: reclaimable is a label until the payer reclaims', () => {
    const expired = fold(expiring)
    expect(expired.stage).toBe('delivered')
    expect(expired.deadlines).toEqual({ ...closedDeadlines, reclaimable: true })

    const back = fold(reclaimedJob)
    expect(back.stage).toBe('reclaimed')
    expect(back.ending).toMatchObject({ _tag: 'Reclaimed', paymentHash: payment, amount: '120000000' })
    expect(back.deadlines).toEqual(closedDeadlines)
  })

  test('delivered and still inside the review window', () => {
    const view = fold({ ...paid, chain: paid.chain.slice(0, 2), now: at(5 * day + 3_600) })
    expect(view.stage).toBe('delivered')
    expect(view.deadlines).toEqual({ ...closedDeadlines, reviewWindowOpen: true })
    expect(view.reviews.map((review) => review.status)).toEqual(['jobNotSettled', 'jobNotSettled'])
  })
})
