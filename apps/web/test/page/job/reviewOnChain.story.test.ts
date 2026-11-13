import { modifyFields } from 'foldkit/struct'
import { Command, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'
import {
  AwaitFeedback,
  ConnectFeedbackWallet,
  init,
  Message,
  Posting,
  PrepareFeedback,
  SendFeedback,
  update,
} from '../../../src/page/job/ReviewOnChain.ts'
import { Problem } from '../../../src/Problem.ts'
import { arcChain, buyerWallet, otherWallet, transactionHash } from './MoneyFixtures.ts'

const subject = 'b0'.repeat(32)
const review = 'e1'.repeat(32)
const call = {
  chainId: arcChain,
  to: '0x8004b663056a597dffe9eccc1965a193b7388713',
  data: '0x3c036a7e',
  from: buyerWallet,
}

const connectedAs = (address: string) =>
  Command.resolve(ConnectFeedbackWallet, Message.SucceededConnectWallet({ connection: { address, chainId: arcChain } }))

describe('posting a counted review to ERC-8004', () => {
  test('the wallet that was the review’s side sends the giveFeedback the core prepares, and waits for it', () =>
    story(
      update,
      given(init('en')),
      message(Message.ClickedPost({ subject, review })),
      Command.expectExact(ConnectFeedbackWallet()),
      connectedAs(buyerWallet),
      Command.expectExact(PrepareFeedback({ subject, review })),
      Command.resolve(PrepareFeedback, Message.SucceededPrepareFeedback({ call })),
      Command.expectExact(SendFeedback({ call })),
      Command.resolve(SendFeedback, Message.SucceededSendFeedback({ hash: transactionHash })),
      Command.expectExact(AwaitFeedback({ hash: transactionHash })),
      Command.resolve(AwaitFeedback, Message.SucceededAwaitFeedback()),
      model((posted) => expect(posted.posting).toEqual(Posting.Posted())),
    ))

  test('another wallet is told which one to use, and sends nothing', () =>
    story(
      update,
      given(init('en')),
      message(Message.ClickedPost({ subject, review })),
      connectedAs(otherWallet),
      Command.resolve(PrepareFeedback, Message.SucceededPrepareFeedback({ call })),
      model((posting) => expect(posting.posting).toEqual(Posting.WrongWallet({ expected: buyerWallet }))),
    ))

  test('says so when the subject has no verified identity, or the wallet failed', () => {
    const preparing = modifyFields(init('en'), {
      posting: () => Posting.Preparing({ subject, review, signer: buyerWallet }),
    })
    const unregistered = update(
      preparing,
      Message.FailedPrepareFeedback({ unregistered: true, problem: Problem.Unavailable() }),
    )
    expect(unregistered.model.posting).toEqual(Posting.Unregistered())
    const refused = update(
      preparing,
      Message.FailedPrepareFeedback({ unregistered: false, problem: Problem.Unreachable() }),
    )
    expect(refused.model.posting).toEqual(Posting.Failed({ problem: Problem.Unreachable() }))
    const mining = modifyFields(init('en'), { posting: () => Posting.Mining({ hash: transactionHash }) })
    expect(update(mining, Message.ClickedPost({ subject, review }))).toEqual({ model: mining })
  })
})
