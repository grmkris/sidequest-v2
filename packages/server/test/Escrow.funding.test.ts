import { it } from '@effect/vitest'
import type { NostrEvent } from '@sidequest/nostr'
import { jobProposal, jobRequest, parseSidequestEvent } from '@sidequest/nostr/vocabulary'
import { Effect, Exit, Option } from 'effect'
import { TestClock } from 'effect/testing'
import type * as Layer from 'effect/Layer'
import { describe, expect } from 'vitest'
import { ChainFacts } from '../src/Index/ChainFacts.ts'
import { Ingest } from '../src/Index/Ingest.ts'
import { fundingRefusal } from '../src/Escrow/FundingRules.ts'
import { escrowStepsWith } from '../src/Escrow/EscrowSteps.ts'
import type { Standing } from '../src/Escrow/Standing.ts'
import {
  accountOf,
  alice,
  bob,
  carol,
  grant,
  indexWorld,
  keyOf,
  linked,
  pubkeyOf,
  revocation,
  walletOne,
  walletTwo,
} from './IndexWorld.ts'
import { onArc, proposalBy, requestBy, statementBy, termsFrom, walletOfKey } from './JobWorld.ts'
import { fakeChain, fundingOf, testChain } from './EscrowWorld.ts'

// Funding a job through the server: what the server checks before it relays the buyer's ERC-3009
// signature, each rule shown refusing on its own (every other rule holding), and the relay when all hold.

const at = 1_800_000_000
const day = 86_400
const terms = termsFrom(at)
const request = await requestBy(alice, at)
const proposal = await proposalBy(bob, request, at + 10, terms)
const aliceWallet = await linked(alice, walletOne, at)
const signature = `0x${'5a'.repeat(65)}` as const

type World = ReturnType<typeof indexWorld>
type Needs = Layer.Success<World['layer']>

/** The index holding `events` (and `facts`), the clock at `now`, and the escrow over a fake chain. */
const funding = <A, E>(
  setup: { readonly events: ReadonlyArray<NostrEvent>; readonly now?: number; readonly reverts?: string },
  use: (
    escrow: Effect.Success<ReturnType<typeof escrowStepsWith>>,
    sent: ReturnType<typeof fakeChain>['sent'],
  ) => Effect.Effect<A, E, Needs>,
) => {
  const world = indexWorld()
  const { chain, sent } = fakeChain(world.sqlite, { now: at }, setup.reverts)
  return Effect.gen(function* () {
    yield* TestClock.setTime((setup.now ?? at + 60) * 1000)
    const index = yield* Ingest
    yield* Effect.forEach(setup.events, (event) => index.ingest(event, 'publish'), { discard: true })
    const escrow = yield* escrowStepsWith(Option.some(chain))
    return { result: yield* Effect.exit(use(escrow, sent)), sent }
  }).pipe(Effect.provide(world.layer))
}

const all = [request, proposal, aliceWallet]
const fund = (
  events: ReadonlyArray<NostrEvent>,
  options: { now?: number; payer?: string; job?: string; reverts?: string } = {},
) =>
  funding({ events, ...options }, (escrow) =>
    escrow.fund(options.job ?? request.id, proposal.id, options.payer ?? walletOne.address, signature),
  )

const reasonOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? JSON.stringify(exit.cause).match(/"reason":"(\w+)"/u)?.[1] : 'relayed'

describe('funding a job through the server', () => {
  it.effect('relays the buyer’s signature with the payment built from the proposal, once every rule holds', () =>
    Effect.gen(function* () {
      const { result, sent } = yield* fund(all)
      const { payment } = yield* Effect.promise(() => fundingOf(proposal, terms, walletOne.address))
      expect(Exit.isSuccess(result)).toBe(true)
      expect(sent).toEqual([
        {
          id: `fund:${payment.hash}`,
          call: { function: 'fund', info: payment.info, params: payment.params, authorization: signature },
        },
      ])
    }),
  )

  it.effect('quotes what the wallet signs: the payment to the proposal’s payTo, and its ERC-3009 authorization', () =>
    Effect.gen(function* () {
      const { result } = yield* funding({ events: all }, (escrow) =>
        escrow.quote(request.id, proposal.id, walletOne.address),
      )
      const { payment } = yield* Effect.promise(() => fundingOf(proposal, terms, walletOne.address))
      expect(Exit.isSuccess(result) && result.value).toMatchObject({
        paymentHash: payment.hash,
        jobParams: { jobId: `0x${request.id}`, arbitrator: testChain.arbitrator },
        paymentInfo: { receiver: payment.info.receiver, payer: walletOne.address, salt: String(payment.info.salt) },
        typedData: { primaryType: 'ReceiveWithAuthorization', message: { nonce: payment.nonce } },
      })
    }),
  )

  it.effect('refuses a job whose request is not indexed', () =>
    Effect.map(fund([proposal, aliceWallet]), ({ result, sent }) => {
      expect(reasonOf(result)).toBe('RequestNotIndexed')
      expect(sent).toEqual([])
    }),
  )

  it.effect('refuses a proposal that is not indexed, or is for another job', () =>
    Effect.gen(function* () {
      expect(reasonOf((yield* fund([request, aliceWallet])).result)).toBe('ProposalNotIndexed')
      const other = yield* Effect.promise(() => requestBy(alice, at + 1, undefined, 'Another job'))
      expect(reasonOf((yield* fund([...all, other], { job: other.id })).result)).toBe('ProposalNotIndexed')
    }),
  )

  it.effect('refuses a proposal that names another buyer', () =>
    Effect.gen(function* () {
      const elsewhere = yield* Effect.promise(() =>
        proposalBy(bob, request, at + 10, terms, undefined, { buyer: pubkeyOf(carol) }),
      )
      const { result, sent } = yield* funding({ events: [request, elsewhere, aliceWallet] }, (escrow) =>
        escrow.fund(request.id, elsewhere.id, walletOne.address, signature),
      )
      expect(reasonOf(result)).toBe('ProposalForOtherBuyer')
      expect(sent).toEqual([])
    }),
  )

  it.effect('refuses a payer whose wallet is not linked to the buyer’s key', () =>
    Effect.gen(function* () {
      expect(reasonOf((yield* fund(all, { payer: walletTwo.address })).result)).toBe('PayerNotLinked')
      const toBob = yield* Effect.promise(() => linked(bob, walletTwo, at + 5))
      expect(reasonOf((yield* fund([...all, toBob], { payer: walletTwo.address })).result)).toBe('PayerNotLinked')
      // A wallet that re-links to another key leaves the buyer.
      const away = yield* Effect.promise(() => linked(bob, walletOne, at + 5))
      expect(reasonOf((yield* fund([...all, away])).result)).toBe('PayerNotLinked')
    }),
  )

  it.effect('refuses a proposal past its validUntil', () =>
    Effect.map(fund(all, { now: at + 10 + 3 * day }), ({ result }) => expect(reasonOf(result)).toBe('ProposalExpired')),
  )

  it.effect('refuses a proposal its author withdrew, but not one someone else claims to withdraw', () =>
    Effect.gen(function* () {
      const withdrawn = yield* Effect.promise(() =>
        statementBy(bob, request.id, 'withdraw_proposal', at + 20, proposal.id),
      )
      expect(reasonOf((yield* fund([...all, withdrawn])).result)).toBe('ProposalWithdrawn')
      const claimed = yield* Effect.promise(() =>
        statementBy(carol, request.id, 'withdraw_proposal', at + 20, proposal.id),
      )
      expect(reasonOf((yield* fund([...all, claimed])).result)).toBe('relayed')
    }),
  )

  it.effect('refuses a proposal its author superseded', () =>
    Effect.gen(function* () {
      const revised = yield* Effect.promise(() =>
        proposalBy(bob, request, at + 30, termsFrom(at, '130000000'), undefined, { previous: proposal.id }),
      )
      expect(reasonOf((yield* fund([...all, revised])).result)).toBe('ProposalSuperseded')
    }),
  )

  it.effect('refuses a job the chain funded already', () =>
    Effect.gen(function* () {
      const { fact } = yield* Effect.promise(() => fundingOf(proposal, terms, walletOne.address))
      const { result, sent } = yield* funding({ events: all }, (escrow) =>
        Effect.andThen(
          Effect.flatMap(ChainFacts, (facts) => facts.record([onArc(fact)])),
          escrow.fund(request.id, proposal.id, walletOne.address, signature),
        ),
      )
      expect(reasonOf(result)).toBe('AlreadyFunded')
      expect(sent).toEqual([])
    }),
  )

  it.effect('refuses what the chain would refuse in simulation, with the chain’s reason', () =>
    Effect.map(fund(all, { reverts: 'AuthorizationExpiryTooEarly' }), ({ result }) => {
      expect(reasonOf(result)).toBe('ChainRefused')
      expect(JSON.stringify(result)).toContain('AuthorizationExpiryTooEarly')
    }),
  )
})

describe('the funding rules', () => {
  const standing = Effect.gen(function* () {
    const parsedRequest = yield* parseSidequestEvent(jobRequest, request)
    const parsedProposal = yield* parseSidequestEvent(jobProposal, proposal)
    const holds: Standing = {
      request: Option.some(parsedRequest),
      proposal: Option.some(parsedProposal),
      bidderGrant: null,
      withdrawn: false,
      superseded: false,
      payerHolder: Option.some(request.pubkey),
      fundedOnChain: false,
    }
    return { holds, payTo: parsedProposal.content.payTo }
  })

  it.effect('refuses a payment whose receiver is not the proposal’s payTo, in any spelling of the same account', () =>
    Effect.gen(function* () {
      const { holds, payTo } = yield* standing
      expect(fundingRefusal(holds, payTo.toUpperCase().replace('EIP155', 'eip155'), at)).toBeUndefined()
      expect(fundingRefusal(holds, accountOf(walletTwo), at)).toBe('ReceiverNotPayTo')
      expect(fundingRefusal(holds, '', at)).toBe('ReceiverNotPayTo')
    }),
  )
})

// Bob's agent proposes under Bob's grant, paying Bob's wallet, as the gateway does: the rules ask about Bob, the bidder.
const agent = keyOf('5'.repeat(64))
const window = { createdAt: at, notBefore: at - 60, expiresAt: at + day }
const proposing = grant(bob, agent, window, ['propose'])
const agentProposal = await proposalBy(agent, request, at + 10, terms, walletOfKey(bob), { grant: proposing.id })
const fundAgents = (extra: ReadonlyArray<NostrEvent>, offer = agentProposal, grants = [proposing]) =>
  funding({ events: [request, aliceWallet, ...grants, offer, ...extra] }, (escrow) =>
    escrow.fund(request.id, offer.id, walletOne.address, signature),
  )

describe('funding a proposal an agent made under its operator’s grant', () => {
  it.effect('relays a payment to the operator’s wallet, the proposal’s payTo', () =>
    Effect.gen(function* () {
      const { result, sent } = yield* fundAgents([])
      const { payment } = yield* Effect.promise(() => fundingOf(agentProposal, terms, walletOne.address))
      expect(reasonOf(result)).toBe('relayed')
      expect(payment.info.receiver.toLowerCase()).toBe(walletOfKey(bob).split(':')[2])
      expect(sent).toMatchObject([{ id: `fund:${payment.hash}` }])
    }),
  )

  it.effect('refuses it once the operator, or their agent, withdrew it; a stranger cannot', () =>
    Effect.gen(function* () {
      const byOperator = yield* Effect.promise(() =>
        statementBy(bob, request.id, 'withdraw_proposal', at + 20, agentProposal.id),
      )
      expect(reasonOf((yield* fundAgents([byOperator])).result)).toBe('ProposalWithdrawn')
      const byAgent = yield* Effect.promise(() =>
        statementBy(agent, request.id, 'withdraw_proposal', at + 20, agentProposal.id, proposing.id),
      )
      expect(reasonOf((yield* fundAgents([byAgent])).result)).toBe('ProposalWithdrawn')
      const carolsAgent = grant(carol, bob, window, ['propose'])
      const byStranger = yield* Effect.promise(() =>
        statementBy(bob, request.id, 'withdraw_proposal', at + 20, agentProposal.id, carolsAgent.id),
      )
      expect(reasonOf((yield* fundAgents([carolsAgent, byStranger])).result)).toBe('relayed')
    }),
  )

  it.effect('refuses it once the operator revised it with their own key', () =>
    Effect.gen(function* () {
      const revised = yield* Effect.promise(() =>
        proposalBy(bob, request, at + 30, termsFrom(at, '130000000'), undefined, { previous: agentProposal.id }),
      )
      expect(reasonOf((yield* fundAgents([revised])).result)).toBe('ProposalSuperseded')
    }),
  )

  it.effect('refuses it as withdrawn when its grant does not authorise it, saying why', () =>
    Effect.gen(function* () {
      const revoked = yield* fundAgents([revocation(bob, proposing.id, at + 30)])
      expect(reasonOf(revoked.result)).toBe('ProposalWithdrawn')
      expect(JSON.stringify(revoked.result)).toContain('revoked')
      expect(reasonOf((yield* fundAgents([revocation(carol, proposing.id, at + 30)])).result)).toBe('relayed')
      expect(JSON.stringify((yield* fundAgents([], agentProposal, [])).result)).toContain('unknownGrant')
      const discussing = grant(bob, agent, window, ['discuss'], 'Talker')
      const unscoped = yield* Effect.promise(() =>
        proposalBy(agent, request, at + 10, terms, walletOfKey(bob), { grant: discussing.id }),
      )
      expect(JSON.stringify((yield* fundAgents([], unscoped, [discussing])).result)).toContain('scopeMissing')
    }),
  )
})
