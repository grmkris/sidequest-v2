import type { JobView } from '@sidequest/fold'
import { Clock, Effect, Predicate } from 'effect'
import type { Browser, Page } from 'playwright'
import { generatePrivateKey } from 'viem/accounts'
import { extensionPerson, fillIn, headlessChromium, reopen, unexplainedProblems } from '../src/test/ChromiumWorld.ts'
import { acceptStanding, postRequest, propose } from '../src/test/MarketWorld.ts'
import { balances, settled } from './Cases.ts'
import type { RehearsalChain } from './Chain.ts'
import { type CaseResult, type Evidence, step } from './Evidence.ts'
import { foldedJob } from './Nostr.ts'
import type { RpcProxy } from './RpcProxy.ts'

// The hire on the website, in Chromium (ROADMAP slice 12): a buyer and a worker, each in their own browser context
// with a NIP-07 extension and a wallet whose key lives in this process, negotiate through signed events and move the
// money with their wallets' signatures, which the job page asks for and the API relays. Every step is a click on what
// the page shows; the test reads the index's fold and the chain only to check what the page said.

export interface BrowserWorld {
  readonly url: string
  readonly chain: RehearsalChain
  readonly proxy: RpcProxy
  readonly evidence: Evidence
}

/** How long a page may take to show what the chain did: the fold follows the chain's logs, polled each minute. */
const chainWait = 330_000
const fee = (captured: bigint) => (captured * 500n) / 10_000n

/** An amount of the 6-decimal test USDC as the page shows it in English. */
const units = (atomic: bigint) => `${(Number(atomic) / 1e6).toFixed(2)} USDC`

const unique = () => generatePrivateKey().slice(2, 10)

const see = (page: Page, text: string | RegExp, timeout = 15_000) =>
  Effect.promise(() => page.getByText(text).first().waitFor({ timeout }))

const press = (page: Page, name: string) =>
  Effect.promise(() => page.getByRole('button', { name, exact: true }).click({ timeout: 15_000 }))

type Person = Effect.Success<ReturnType<typeof extensionPerson>>

/** Every error each page reported, less the 404s of reading a key the index did not know yet. */
const problemsOf = (people: ReadonlyArray<Person>) =>
  people.flatMap((person) => unexplainedProblems(person.problems, person.notFound, person.pubkey))

/** The buyer posts a request, the worker proposes the chain's amount in USDC, the buyer accepts: signals only. */
const agreed = (world: BrowserWorld, browser: Browser, label: string) =>
  Effect.gen(function* () {
    const buyer = yield* extensionPerson(browser, world.url, true)
    const worker = yield* extensionPerson(browser, world.url, true)
    yield* Effect.promise(async () => world.chain.mint?.(buyer.wallet.address, world.chain.amount))
    const jobPath = yield* postRequest(buyer.page, `A poster from the browser, ${label} ${unique()}`)
    yield* reopen(worker.page, `${world.url}${jobPath}`)
    yield* propose(worker.page, String(world.chain.amount / 1_000_000n))
    yield* reopen(buyer.page, `${world.url}${jobPath}`)
    yield* acceptStanding(buyer.page)
    const job = jobPath.slice('/jobs/'.length)
    step(world.evidence, {
      case: label,
      step: 'in two browsers: the buyer posted a request, the worker proposed, the buyer accepted',
      detail: { job },
    })
    return { buyer, worker, job, jobPath }
  })

type Deal = Effect.Success<ReturnType<typeof agreed>>

const folded = (world: BrowserWorld, deal: Deal, stage: JobView['stage']) =>
  Effect.promise(() => foldedJob(world.url, deal.job, (view) => view.stage === stage, 60))

/** The buyer reads the slip (the amount, the fee, the worker's wallet, that it binds) and signs it in their wallet. */
const funded = (world: BrowserWorld, label: string, deal: Deal) =>
  Effect.gen(function* () {
    const page = deal.buyer.page
    yield* press(page, 'Review the payment')
    const slip = page.getByRole('region', { name: 'What you sign' })
    yield* Effect.promise(() => slip.getByText('This is the step that binds', { exact: false }).waitFor())
    const shownFee = `that is ${units(fee(world.chain.amount))}`
    yield* Effect.promise(() => slip.getByText(shownFee, { exact: false }).waitFor())
    yield* Effect.promise(() => slip.getByText(deal.worker.wallet.address, { exact: true }).waitFor())
    yield* press(page, 'Sign and fund')
    yield* see(page, 'The escrow is funded. The terms now bind you both.', chainWait)
    step(world.evidence, { case: label, step: 'the buyer read the slip, signed in their wallet; the page says funded' })
    yield* folded(world, deal, 'funded')
  })

/** The worker says where the work is; the page publishes the note and their wallet signs its hash. */
const delivered = (world: BrowserWorld, label: string, deal: Deal) =>
  Effect.gen(function* () {
    const page = deal.worker.page
    yield* reopen(page, `${world.url}${deal.jobPath}`)
    yield* press(page, 'Deliver the work')
    yield* fillIn(page, {
      'Where the buyer gets it': 'https://files.example/poster.pdf',
      'Note for the buyer': 'The A2 poster, print-ready, two colours.',
    })
    yield* press(page, 'Publish and sign the delivery')
    yield* see(page, 'Your delivery is on chain.', chainWait)
    const view = yield* folded(world, deal, 'delivered')
    if (!view.deliveryNotes.some((note) => note.fromWorker && note.matchesChain))
      return yield* Effect.die(new Error('The fold has no delivery note of the worker matching the chain'))
    step(world.evidence, {
      case: label,
      step: 'the worker published a delivery note and signed its hash; the fold matches it with the chain',
    })
  })

const caseResult = (label: string, title: string, durationMs: number, deal: Deal, view: JobView): CaseResult => ({
  case: label,
  title,
  status: 'passed',
  job: deal.job,
  outcome: view.stage,
  settlement: view.ending === null ? [] : [JSON.stringify(view.ending)],
  durationMs,
})

/** (a) Funded, delivered and approved on the website: the page ends at Paid, with the exact fee. */
export const releasedInBrowser = (world: BrowserWorld) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    const browser = yield* headlessChromium
    const deal = yield* agreed(world, browser, 'a')
    const wallets = { chain: world.chain, buyer: deal.buyer, worker: deal.worker }
    const before = yield* Effect.promise(() => balances(wallets))
    yield* funded(world, 'a', deal)
    yield* delivered(world, 'a', deal)
    const page = deal.buyer.page
    yield* reopen(page, `${world.url}${deal.jobPath}`)
    yield* press(page, 'Approve and pay')
    yield* press(page, 'Sign the approval')
    yield* see(page, 'You approved the work. The escrow paid the worker.', chainWait)
    const onChain = page.getByRole('region', { name: 'On chain' })
    const { amount } = world.chain
    yield* Effect.promise(() => onChain.getByText('The buyer approved the work, and the worker was paid.').waitFor())
    yield* Effect.promise(() => onChain.getByText(units(fee(amount)), { exact: true }).waitFor())
    yield* Effect.promise(() => onChain.getByText(units(amount - fee(amount)), { exact: true }).waitFor())
    yield* see(page, 'Paid')
    const view = yield* folded(world, deal, 'released')
    if (!Predicate.isTagged(view.ending, 'Settled') || view.ending.feeAmount !== String(fee(amount)))
      return yield* Effect.die(new Error(`Released, yet ${JSON.stringify(view.ending)}`))
    step(world.evidence, {
      case: 'a',
      step: 'the buyer approved in their wallet; the page shows Paid with the worker’s part and the exact fee',
      detail: { fee: String(fee(amount)) },
    })
    const rows = yield* Effect.promise(() =>
      settled(wallets, before, { buyer: -amount, worker: amount - fee(amount), treasury: fee(amount) }),
    )
    const problems = problemsOf([deal.buyer, deal.worker])
    if (problems.length > 0) return yield* Effect.die(new Error(`The pages reported: ${problems.join('; ')}`))
    return {
      ...caseResult(
        'a',
        'released on the website with the exact fee',
        (yield* Clock.currentTimeMillis) - started,
        deal,
        view,
      ),
      balances: rows,
    }
  })

/** (b) Funded and delivered on the website, then rejected with a reason: the page says an arbitrator will rule. */
export const disputedInBrowser = (world: BrowserWorld) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    const browser = yield* headlessChromium
    const deal = yield* agreed(world, browser, 'b')
    yield* funded(world, 'b', deal)
    yield* delivered(world, 'b', deal)
    const page = deal.buyer.page
    const reason = 'The bleed for print is missing.'
    yield* reopen(page, `${world.url}${deal.jobPath}`)
    yield* press(page, 'Reject')
    yield* fillIn(page, { 'Why you reject it': reason })
    yield* press(page, 'Publish and sign the rejection')
    yield* see(page, 'You rejected the delivery. An arbitrator will rule.', chainWait)
    yield* see(page, /The buyer rejected the delivery on .+\. An arbitrator will rule by .+; without a ruling/u)
    yield* see(page, 'Arbitration open')
    yield* see(page, reason)
    const view = yield* folded(world, deal, 'rejected')
    if (!view.statements.some((said) => said.content.type === 'rejection_reason' && said.effective))
      return yield* Effect.die(new Error('The fold has no effective rejection reason'))
    step(world.evidence, {
      case: 'b',
      step: 'the buyer published a reason and signed the rejection; the page shows the dispute and its deadline',
      detail: { arbitrationEndsAt: view.rejection?.arbitrationEndsAt ?? 0 },
    })
    const problems = problemsOf([deal.buyer, deal.worker])
    if (problems.length > 0) return yield* Effect.die(new Error(`The pages reported: ${problems.join('; ')}`))
    return caseResult(
      'b',
      'rejected on the website; an arbitrator will rule',
      (yield* Clock.currentTimeMillis) - started,
      deal,
      view,
    )
  })
