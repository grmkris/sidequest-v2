import { Option } from 'effect'
import { AsyncData } from 'foldkit'
import { Command, click, expect, given, inside, role, scene, text, withViewInputs } from 'foldkit/scene'
import { modifyFields } from 'foldkit/struct'
import { describe, test } from 'vitest'
import { CancelRequest, Decide, init, Message, type Model, ReadJob, update } from '../../../src/page/job/Job.ts'
import { view } from '../../../src/page/job/JobPage.ts'
import * as Room from '../../../src/page/job/Room.ts'
import { Problem } from '../../../src/Problem.ts'
import { Session } from '../../../src/Session.ts'
import { ada, ben, bidderPending, buyerOpen, job, publicOpen, wallet } from '../../Fixtures.ts'
import { Digest, type JobView, type ProposalRef } from '@sidequest/protocol'

const signedOut = withViewInputs(view, { session: Session.SignedOut(), me: Option.none() })
const asAda = withViewInputs(view, { session: Session.SignedOut(), me: Option.some(ada) })

/** The job page once the job read answered with `jobView`. */
const showing = (jobView: JobView): Model =>
  update(
    modifyFields(init('en', job, Option.some(wallet), false).model, { view: () => AsyncData.Loading() }),
    Message.SucceededReadJob({ view: jobView }),
  ).model

const benV2: ProposalRef = { bidder: ben, version: 2, termsDigest: Digest.make('b'.repeat(64)) }

describe('the job page, for its buyer', () => {
  test('shows each bidder’s newest version with its terms, earlier versions folded away', () => {
    scene(
      { update, view: asAda() },
      given(showing(buyerOpen)),
      expect(role('heading', { level: 1, name: 'A logo for my café' })).toExist(),
      expect(role('heading', { name: 'From account …000BEN' })).toExist(),
      expect(role('heading', { name: 'From account …000CEE' })).toExist(),
      expect(text('Version 2, the latest')).toExist(),
      expect(text('300.00 USDC')).toExist(),
      expect(text('1 earlier version')).toExist(),
      expect(role('button', { name: 'Accept version 2' })).toExist(),
      expect(role('button', { name: 'Accept version 1' })).toExist(),
    )
  })

  test('accepts exactly the version on screen, after saying what that binds', () => {
    scene(
      { update, view: asAda() },
      given(showing(buyerOpen)),
      inside(role('article', { name: /000BEN/u }), click(role('button', { name: 'Accept version 2' }))),
      Command.expectNone(),
      expect(text(/It becomes the agreement on exactly these terms: 300\.00 USDC/u)).toExist(),
      click(role('button', { name: 'Accept version 2' })),
      Command.resolve(Decide({ job, ref: benV2, accept: true }), Message.SucceededDecide()),
      Command.resolve(ReadJob({ job }), Message.SucceededReadJob({ view: buyerOpen })),
      Command.resolve(Room.ListRooms({ job }), Room.Message.SucceededListRooms({ rooms: [] })),
    )
  })

  test('asks a bidder to change their newest version, and shows a refusal', () => {
    scene(
      { update, view: asAda() },
      given(showing(buyerOpen)),
      inside(role('article', { name: /000BEN/u }), click(role('button', { name: 'Ask for a change' }))),
      Command.resolve(
        Decide({ job, ref: benV2, accept: false }),
        Message.FailedDecide({ problem: Problem.Conflict({ reason: 'StaleHead' }) }),
      ),
      expect(role('alert')).toContainText('A newer version of this proposal exists.'),
    )
  })

  test('cancels an open request only after a second click', () => {
    scene(
      { update, view: asAda() },
      given(showing(buyerOpen)),
      click(role('button', { name: 'Cancel the request' })),
      Command.expectNone(),
      expect(text(/it can't be reopened/u)).toExist(),
      click(role('button', { name: 'Cancel the request' })),
      Command.resolve(CancelRequest({ job }), Message.SucceededDecide()),
      Command.resolve(ReadJob, Message.SucceededReadJob({ view: buyerOpen })),
      Command.resolve(Room.ListRooms, Room.Message.SucceededListRooms({ rooms: [] })),
    )
  })
})

describe('the job page, for a bidder', () => {
  test('shows their own versions, the change asked for, and a form for the next version', () => {
    scene(
      { update, view: withViewInputs(view, { session: Session.SignedOut(), me: Option.some(ben) })() },
      given(showing(bidderPending)),
      expect(role('heading', { level: 1, name: 'Your proposal: A logo, version 2' })).toExist(),
      expect(text('The buyer asked for a change to this version')).toExist(),
      expect(role('heading', { name: 'Send a new version' })).toExist(),
    )
  })
})

describe('the job page, for anyone else', () => {
  test('shows the request and asks a signed-out visitor to sign in to propose', () => {
    scene(
      { update, view: signedOut() },
      given(showing(publicOpen)),
      expect(text('Warm colours.')).toExist(),
      expect(text('Open')).toExist(),
      expect(role('link', { name: 'Sign in to make a proposal' })).toHaveAttr('href', `/sign-in?next=%2Fjobs%2F${job}`),
    )
  })

  test('says why a job cannot be shown', () => {
    scene(
      { update, view: signedOut() },
      given(
        update(
          init('en', job, Option.none(), false).model,
          Message.FailedReadJob({ problem: Problem.NotFound({ reason: 'UnknownJob' }) }),
        ).model,
      ),
      expect(role('heading', { level: 1, name: "This job can't be shown" })).toExist(),
      expect(role('alert')).toContainText('There is no such job.'),
    )
  })
})
