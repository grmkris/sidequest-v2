import { Option } from 'effect'
import { change, Command, expect, expectOutMessage, given, label, role, scene, submit, text } from 'foldkit/scene'
import { describe, test } from 'vitest'
import { init, LeaveReview, Message, OutMessage, update, view } from '../../../src/page/job/Review.ts'
import { Problem } from '../../../src/Problem.ts'
import { job } from '../../Fixtures.ts'

describe('reviewing the other side after settlement', () => {
  test('needs a rating, then sends it with no comment', () => {
    scene(
      { update, view },
      given(init('en', job)),
      submit(role('form')),
      Command.expectNone(),
      expect(text(/Pick a rating/u)).toExist(),
      change(label('4 stars'), '4'),
      submit(role('form')),
      Command.resolve(LeaveReview({ job, rating: 4, maybeComment: Option.none() }), Message.SucceededLeaveReview()),
      expectOutMessage(OutMessage.Reviewed()),
      expect(text('Your review is in. Thank you.')).toExist(),
    )
  })

  test('a review given already counts as given', () => {
    scene(
      { update, view },
      given(init('en', job)),
      change(label('1 star'), '1'),
      submit(role('form')),
      Command.resolve(
        LeaveReview,
        Message.FailedLeaveReview({ problem: Problem.Conflict({ reason: 'AlreadyReviewed' }) }),
      ),
      expect(text('Your review is in. Thank you.')).toExist(),
    )
  })
})
