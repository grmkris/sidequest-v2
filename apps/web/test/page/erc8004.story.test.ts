import { Erc8004Deployment, Erc8004Identity } from '@sidequest/protocol'
import { Option, Schema } from 'effect'
import { AsyncData } from 'foldkit'
import { modifyFields } from 'foldkit/struct'
import { Command, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'
import {
  AwaitRegistration,
  ConnectRegistrationWallet,
  Flow,
  init,
  Message,
  mintedAgentId,
  type Model,
  PrepareRegistration,
  PublishClaim,
  readFor,
  ReadSummaries,
  RegistrationFailure,
  SendRegistration,
  summaryOf,
  update,
} from '../../src/page/Erc8004.ts'
import { Problem } from '../../src/Problem.ts'
import { PublishFailure, PublishRefusal } from '../../src/Publishing.ts'
import { arcChain, transactionHash, workerWallet } from './job/MoneyFixtures.ts'

const agent = 'a9'.repeat(32)
const registryAddress = '0x8004a818bfb912233c491871b3d84c89a494bd9e'
const registry = `eip155:${arcChain}:${registryAddress}`
const mcp = Option.some('https://agents.sidequest.test/mcp')
const deployment = {
  chainId: arcChain,
  identityRegistry: registry,
  reputationRegistry: `eip155:${arcChain}:0x8004b663056a597dffe9eccc1965a193b7388713`,
}
const call = {
  chainId: arcChain,
  to: registryAddress,
  data: '0xf2c298be',
  agentURI: `https://sidequest.test/api/erc8004/agents/${agent}/registration`,
}
const identity = (status: 'verified' | 'unchecked') =>
  Schema.decodeSync(Erc8004Identity)({
    registry,
    agentId: '7',
    claim: 'cc'.repeat(32),
    claimedBy: 'b0'.repeat(32),
    mcp: null,
    status,
    failure: null,
    readAtBlock: status === 'verified' ? 12 : null,
  })

/** The page read the stage's registries and the agent's summary: not registered. */
const read: Model = [
  Message.SucceededReadDeployment({ deployment: Schema.decodeSync(Erc8004Deployment)(deployment) }),
  Message.SucceededReadSummaries({ summaries: [{ agent, identities: [], count: 0, averageRating: null }] }),
].reduce((page, received) => update(page, received).model, init('en'))

const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`
const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const minted = (agentId: bigint, from = 0n, address = registryAddress) => ({
  address,
  topics: [transferTopic, word(from), word(BigInt(workerWallet)), word(agentId)],
})

/** The names of the Commands an update returned. */
const namesOf = (returned: { readonly commands?: ReadonlyArray<{ readonly name: string }> }) =>
  (returned.commands ?? []).map((command) => command.name)

describe('ERC-8004 on the agents page', () => {
  test('reads the stage’s registries once, and the agents’ summaries whenever the list is read', () => {
    const first = readFor(init('en'), [agent])
    expect(namesOf(first)).toEqual(['ReadDeployment', 'ReadSummaries'])
    expect(namesOf(readFor(first.model, [agent]))).toEqual(['ReadSummaries'])
    expect(namesOf(readFor(first.model, []))).toEqual([])
  })

  test('the operator’s wallet registers the agent with the file the core names, then their key claims the token', () =>
    story(
      update,
      given(read),
      message(Message.ClickedRegister({ agent, maybeMcp: mcp })),
      Command.expectExact(ConnectRegistrationWallet()),
      Command.resolve(
        ConnectRegistrationWallet,
        Message.SucceededConnectWallet({ connection: { address: workerWallet, chainId: arcChain } }),
      ),
      Command.expectExact(PrepareRegistration({ agent })),
      Command.resolve(PrepareRegistration, Message.SucceededPrepareRegistration({ call })),
      Command.expectExact(SendRegistration({ signer: workerWallet, call })),
      Command.resolve(SendRegistration, Message.SucceededSendRegistration({ hash: transactionHash })),
      Command.expectExact(AwaitRegistration({ hash: transactionHash, registry })),
      Command.resolve(AwaitRegistration, Message.SucceededAwaitRegistration({ agentId: '7' })),
      Command.expectExact(PublishClaim({ agent, registry, agentId: '7', maybeMcp: mcp })),
      Command.resolve(PublishClaim, Message.SucceededPublishClaim()),
      Command.expectExact(ReadSummaries({ agents: [agent] })),
      Command.resolve(
        ReadSummaries,
        Message.SucceededReadSummaries({
          summaries: [{ agent, identities: [identity('unchecked')], count: 0, averageRating: null }],
        }),
      ),
      model((page) => {
        expect(page.flow).toEqual(Flow.Claimed({ agent, agentId: '7' }))
        expect(Option.map(summaryOf(page, agent), ({ identities }) => identities)).toEqual(
          Option.some([identity('unchecked')]),
        )
      }),
    ))

  test('says why a registration stopped: the wallet refused, nothing was minted, the index refused the claim', () => {
    const problem = Problem.WalletRejected()
    story(
      update,
      given(read),
      message(Message.ClickedRegister({ agent, maybeMcp: Option.none() })),
      Command.resolve(ConnectRegistrationWallet, Message.FailedConnectWallet({ problem })),
      model((page) =>
        expect(page.flow).toEqual(Flow.Failed({ agent, failure: RegistrationFailure.Failed({ problem }) })),
      ),
    )
    const refusal = PublishFailure.Refused({ refusal: PublishRefusal.KindNotIndexed() })
    const mining = Flow.Mining({ agent, maybeMcp: Option.none(), registry, hash: transactionHash })
    const notMinted = update(
      modifyFields(read, { flow: () => mining }),
      Message.FailedAwaitRegistration({ failure: RegistrationFailure.NotMinted() }),
    )
    expect(notMinted.model.flow).toEqual(Flow.Failed({ agent, failure: RegistrationFailure.NotMinted() }))
    const claiming = update(
      modifyFields(read, { flow: () => Flow.Claiming({ agent, agentId: '7' }) }),
      Message.FailedPublishClaim({ failure: refusal }),
    )
    expect(claiming.model.flow).toEqual(
      Flow.Failed({ agent, failure: RegistrationFailure.Claim({ failure: refusal }) }),
    )
  })

  test('ignores a second registration while one is under way, and a late answer for a closed one', () => {
    const connecting = update(read, Message.ClickedRegister({ agent, maybeMcp: Option.none() })).model
    expect(update(connecting, Message.ClickedRegister({ agent: 'b1'.repeat(32), maybeMcp: Option.none() }))).toEqual({
      model: connecting,
    })
    const closed = update(connecting, Message.ClickedCloseRegistration()).model
    expect(update(closed, Message.SucceededPrepareRegistration({ call }))).toEqual({ model: closed })
    expect(AsyncData.isSuccess(closed.deployment)).toBe(true)
  })

  test('reads the minted id from the registry’s Transfer from nobody, and nothing else', () => {
    expect(mintedAgentId([minted(7n)], registry)).toEqual(Option.some('7'))
    expect(mintedAgentId([minted(2n ** 200n)], registry)).toEqual(Option.some((2n ** 200n).toString()))
    expect(mintedAgentId([minted(7n, 5n)], registry)).toEqual(Option.none())
    expect(mintedAgentId([minted(7n, 0n, `0x${'12'.repeat(20)}`)], registry)).toEqual(Option.none())
    expect(mintedAgentId([], registry)).toEqual(Option.none())
  })
})
