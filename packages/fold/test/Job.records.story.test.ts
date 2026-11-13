import { Option } from 'effect'
import { describe, expect, test } from 'vitest'
import { foldJob, foldJobs } from '../src/FoldJob.ts'
import { accept, at, day, funded, hour, note, proposal, pub, say } from './fixtures.ts'
import { fold } from './fold.ts'
import { closed, closingIds, expiredOpen, job, offered, paid, reviewed, reviewedEarly, reviewIds } from './stories.ts'

describe('reviews, notes and statements count only from the right keys', () => {
  test('a stranger’s review is ignored, each side’s latest counts, a same-second tie goes to the lowest id', () => {
    const view = fold(reviewed)
    const statusOf = (id: string) => view.reviews.find((review) => review.id === id)?.status
    expect(statusOf(reviewIds.stranger)).toBe('stranger')
    expect(statusOf(reviewIds.buyerFirst)).toBe('replaced')
    expect(statusOf(reviewIds.buyerLater)).toBe('counted')
    expect(reviewIds.workerTwins.map(statusOf)).toEqual(['counted', 'replaced'])
    expect(view.reviews.find((review) => review.id === reviewIds.stranger)?.side).toBeNull()
  })

  test('before settlement no review counts', () => {
    const view = fold(reviewedEarly)
    expect(view.stage).toBe('delivered')
    expect(new Set(view.reviews.map((review) => review.status))).toEqual(new Set(['jobNotSettled']))
  })

  test('a note from anyone but the worker, or with another hash, is labelled', async () => {
    const strangerNote = await note(job, 'stranger', at(5 * day + 1))
    const wrongHash = await note(job, 'worker', at(5 * day + 2), `0x${'ee'.repeat(32)}`)
    const view = fold({ ...paid, events: [...paid.events, strangerNote, wrongHash] })
    expect(
      view.deliveryNotes.map(({ author, fromWorker, matchesChain }) => [author, fromWorker, matchesChain]),
    ).toEqual([
      [pub('worker'), true, true],
      [pub('stranger'), false, true],
      [pub('worker'), true, false],
    ])
  })

  test('only a proposal’s author can withdraw it', async () => {
    const meddling = await say(job, 'buyer', 'withdraw_proposal', at(3 * hour), offered.event.id)
    const view = fold({ ...expiredOpen, events: [...expiredOpen.events, meddling], now: at(4 * hour) })
    expect(view.stage).toBe('proposed')
    expect(view.proposals.map((offer) => offer.withdrawn)).toEqual([false])
    expect(view.statements.find((said) => said.id === meddling.parsed.event.id)?.effective).toBe(false)
  })

  test('the buyer’s withdrawal closes the request; a stranger’s says nothing; expiry is only a label', () => {
    const shut = fold(closed)
    expect(shut.stage).toBe('closed')
    expect(shut.request).toMatchObject({ closedByBuyer: true, expired: true })
    expect(Object.fromEntries(shut.statements.map(({ id, effective }) => [id, effective]))).toEqual({
      [closingIds.buyer]: true,
      [closingIds.stranger]: false,
    })

    const lapsed = fold(expiredOpen)
    expect(lapsed.stage).toBe('proposed')
    expect(lapsed.request).toMatchObject({ closedByBuyer: false, expired: true })
    expect(lapsed.proposals.map((offer) => offer.expired)).toEqual([true])
  })

  test('two of the worker’s proposals carry the funded terms: the accepted one is funded, labelled ambiguous', async () => {
    const twin = await proposal({ job, by: 'worker', createdAt: at(30 * 60) })
    const later = await accept(twin.parsed, at(3 * hour))
    const chain = [funded({ job, termsDigest: offered.content.termsDigest })]
    const onlyFirst = fold({ ...paid, events: [...paid.events, twin], chain })
    const ids = [offered.event.id, twin.parsed.event.id].toSorted()
    expect(onlyFirst.funding).toMatchObject({ proposal: offered.event.id, termsAmbiguous: true })
    const bothAccepted = fold({ ...paid, events: [...paid.events, twin, later], chain })
    expect(bothAccepted.funding).toMatchObject({ proposal: ids[0], termsAmbiguous: true })
  })
})

describe('jobs are told apart by their request', () => {
  test('another job’s events and chain facts are ignored', () => {
    const view = fold(paid)
    expect(view.proposals.map((offer) => offer.id)).toEqual([offered.event.id])
    const otherJob = paid.events.find((event) => event.type === 'request' && event.parsed.event.id !== job)
    const elsewhere = otherJob?.parsed.event.id ?? job
    const stray = funded({ job: elsewhere, termsDigest: offered.content.termsDigest, block: 50 })
    expect(fold({ ...paid, chain: [...paid.chain, stray] })).toEqual(view)
  })

  test('without its request there is no job to fold', () => {
    expect(Option.isNone(foldJob({ ...paid, events: paid.events.filter((event) => event.type !== 'request') }))).toBe(
      true,
    )
  })

  test('a mixed bag folds into one view per request, in order of job id', () => {
    const views = foldJobs(paid)
    expect(views).toHaveLength(2)
    expect(views.map((view) => view.job)).toEqual(views.map((view) => view.job).toSorted())
    expect(views.find((view) => view.job === job)).toEqual(fold(paid))
    expect(views.find((view) => view.job !== job)?.stage).toBe('proposed')
  })
})
