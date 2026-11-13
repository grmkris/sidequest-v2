import { IndexSettlementRefused } from '@sidequest/protocol'
import { Option } from 'effect'
import { AsyncData } from 'foldkit'
import { Command, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'
import { GatewayRefusal, GatewayRefused } from '../../src/Gateway.ts'
import {
  ConnectWallet,
  DelegationFailure,
  delegationFailureOf,
  Flow,
  init,
  Message,
  type Model,
  PrepareDelegation,
  ReadWorkerJobs,
  SignDelegation,
  StoreDelegation,
  update,
} from '../../src/page/Delegation.ts'
import { Problem } from '../../src/Problem.ts'
import { bidderKey, now, requestId } from '../Fixtures.ts'
import { arcChain, otherWallet, signature, typedDataOn, workerWallet } from './job/MoneyFixtures.ts'

const agent = 'a9'.repeat(32)
const workerJob = {
  job: requestId,
  title: 'A logo for my café',
  receiver: workerWallet,
  deliveryDeadline: now + 86_400,
}
const typedData = typedDataOn('DeliveryDelegate')
const expiry = now + 7 * 86_400

/** The worker opened a delegation for the agent, the page read their funded job, and they chose it. */
const chosen = [
  message(Message.ClickedDelegate({ agent, pubkey: bidderKey })),
  Command.expectExact(ReadWorkerJobs({ pubkey: bidderKey })),
  Command.resolve(ReadWorkerJobs, Message.SucceededReadWorkerJobs({ jobs: [workerJob] })),
  message(Message.SelectedJob({ job: requestId })),
  message(Message.SubmittedDelegation()),
  Command.expectExact(ConnectWallet()),
]

const connectedAs = (address: string) =>
  Command.resolve(ConnectWallet, Message.SucceededConnectWallet({ connection: { address, chainId: arcChain } }))

const fresh: Model = init('en')

describe('delivery delegation', () => {
  test('the worker’s wallet signs the core’s DeliveryDelegate for the agent, and the gateway stores it', () => {
    story(
      update,
      given(fresh),
      ...chosen,
      connectedAs(workerWallet),
      Command.expectExact(PrepareDelegation({ agent, job: requestId, days: '7' })),
      Command.resolve(PrepareDelegation, Message.SucceededPrepare({ expiry, typedData })),
      Command.expectExact(SignDelegation({ signer: workerWallet, typedData })),
      Command.resolve(SignDelegation, Message.SucceededSign({ signature })),
      Command.expectExact(StoreDelegation({ agent, job: requestId, signature, expiry })),
      Command.resolve(StoreDelegation, Message.SucceededStore()),
      model((page) => expect(page.flow).toEqual(Flow.Stored({ agent, job: requestId, expiry }))),
    )
  })

  test('a wallet other than the one the escrow pays is named, and nothing is signed until the right one answers', () => {
    story(
      update,
      given(fresh),
      ...chosen,
      connectedAs(otherWallet),
      model((page) =>
        expect(page.flow).toEqual(
          Flow.WrongWallet({ agent, job: requestId, days: '7', receiver: workerWallet, connected: otherWallet }),
        ),
      ),
      Command.expectNone(),
      message(Message.ClickedTryAgain()),
      Command.expectExact(ConnectWallet()),
      connectedAs(workerWallet.toUpperCase().replace('0X', '0x')),
      Command.expectExact(PrepareDelegation({ agent, job: requestId, days: '7' })),
      Command.resolve(PrepareDelegation, Message.SucceededPrepare({ expiry, typedData })),
      Command.resolve(SignDelegation, Message.SucceededSign({ signature })),
      Command.resolve(StoreDelegation, Message.SucceededStore()),
    )
  })

  test('the person declining in their wallet stops it, and nothing reaches the gateway', () => {
    story(
      update,
      given(fresh),
      ...chosen,
      connectedAs(workerWallet),
      Command.resolve(PrepareDelegation, Message.SucceededPrepare({ expiry, typedData })),
      Command.resolve(SignDelegation, Message.FailedSign({ problem: Problem.WalletRejected() })),
      model((page) =>
        expect(page.flow).toEqual(
          Flow.Failed({ agent, failure: DelegationFailure.Failed({ problem: Problem.WalletRejected() }) }),
        ),
      ),
      Command.expectNone(),
    )
  })

  test('a refusal of the core or the gateway stops it with that refusal', () => {
    for (const failure of [
      DelegationFailure.Core({ reason: 'NotFunded' }),
      DelegationFailure.Gateway({ refusal: GatewayRefusal.UnknownAgent() }),
      DelegationFailure.Gateway({ refusal: GatewayRefusal.Unauthorized({ reason: 'stale' }) }),
    ]) {
      story(
        update,
        given(fresh),
        ...chosen,
        connectedAs(workerWallet),
        Command.resolve(PrepareDelegation, Message.FailedPrepare({ failure })),
        model((page) => expect(page.flow).toEqual(Flow.Failed({ agent, failure }))),
      )
    }
    const unavailable = DelegationFailure.Gateway({ refusal: GatewayRefusal.Unavailable() })
    story(
      update,
      given(fresh),
      ...chosen,
      connectedAs(workerWallet),
      Command.resolve(PrepareDelegation, Message.SucceededPrepare({ expiry, typedData })),
      Command.resolve(SignDelegation, Message.SucceededSign({ signature })),
      Command.resolve(StoreDelegation, Message.FailedStore({ failure: unavailable })),
      model((page) => expect(page.flow).toEqual(Flow.Failed({ agent, failure: unavailable }))),
    )
  })

  test('asks for a job before anything, and reads the worker’s jobs once', () => {
    story(
      update,
      given(fresh),
      message(Message.ClickedDelegate({ agent, pubkey: bidderKey })),
      Command.resolve(ReadWorkerJobs, Message.SucceededReadWorkerJobs({ jobs: [workerJob] })),
      message(Message.SubmittedDelegation()),
      model((page) =>
        expect(page.flow).toEqual(Flow.Choosing({ agent, maybeJob: Option.none(), days: '7', invalid: true })),
      ),
      Command.expectNone(),
      message(Message.ClickedCancel()),
      message(Message.ClickedDelegate({ agent, pubkey: bidderKey })),
      Command.expectNone(),
      model((page) => expect(AsyncData.isSuccess(page.jobs)).toBe(true)),
    )
  })

  test('reads each error as its failure', () => {
    expect(delegationFailureOf(new IndexSettlementRefused({ reason: 'AlreadyFunded' }))).toEqual(
      DelegationFailure.Core({ reason: 'AlreadyFunded' }),
    )
    expect(delegationFailureOf(new GatewayRefused({ refusal: GatewayRefusal.Invalid() }))).toEqual(
      DelegationFailure.Gateway({ refusal: GatewayRefusal.Invalid() }),
    )
  })
})
