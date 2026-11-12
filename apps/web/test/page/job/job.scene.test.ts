import { Option } from 'effect'
import { AsyncData } from 'foldkit'
import { Command, click, expect, given, inside, role, scene, text, withViewInputs } from 'foldkit/scene'
import { modifyFields } from 'foldkit/struct'
import { describe, expect as assert, test } from 'vitest'
import {
  CancelRequest,
  Decide,
  init,
  Message,
  type Model,
  ReadJob,
  ReadNames,
  update,
} from '../../../src/page/job/Job.ts'
import { Preload } from '../../../src/Preload.ts'
import { view } from '../../../src/page/job/JobPage.ts'
import * as Room from '../../../src/page/job/Room.ts'
import { Problem } from '../../../src/Problem.ts'
import { Session } from '../../../src/Session.ts'
import { ada, ben, bidderPending, buyerOpen, cleo, job, publicOpen, wallet, workerSettled } from '../../Fixtures.ts'
import { Digest, type JobView, type ProposalRef } from '@sidequest/protocol'

const signedOut = withViewInputs(view, { session: Session.SignedOut(), me: Option.none(), timeZone: 'UTC' })
const asAda = withViewInputs(view, { session: Session.SignedOut(), me: Option.some(ada), timeZone: 'UTC' })
const asBen = withViewInputs(view, { session: Session.SignedOut(), me: Option.some(ben), timeZone: 'UTC' })

/** The job page once the job read answered with `jobView`. */
const showing = (jobView: JobView): Model =>
  update(
    modifyFields(init('en', job, Option.some(wallet), false, Option.none()).model, { view: () => AsyncData.Loading() }),
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

  test('names the buyer and every bidder once their names are read, in one lookup', () => {
    const read = update(
      init('en', job, Option.some(wallet), false, Option.none()).model,
      Message.SucceededReadJob({ view: buyerOpen }),
    )
    assert(read.commands?.map((command) => command.name)).toEqual([ReadNames.name])
    assert(read.model.askedNames).toEqual([ada, ben, cleo])
    // The view read again asks for no name already asked for.
    assert(update(read.model, Message.SucceededReadJob({ view: buyerOpen })).commands ?? []).toEqual([])
    scene(
      { update, view: asAda() },
      given(
        update(
          read.model,
          Message.SucceededReadNames({
            names: [
              { account: ben, displayName: 'Ben Bitdiddle' },
              { account: cleo, displayName: 'Cleo' },
            ],
          }),
        ).model,
      ),
      expect(role('heading', { name: 'From Ben Bitdiddle' })).toExist(),
      expect(role('heading', { name: 'From Cleo' })).toExist(),
      // An account with no name recorded keeps its short id.
      expect(text('account …000ADA')).toExist(),
    )
  })

  test('shows the job the server read, with its names, and reads neither again', () => {
    const opened = init(
      'en',
      job,
      Option.some(wallet),
      false,
      Option.some(Preload.Job({ view: buyerOpen, names: [{ account: ben, displayName: 'Ben Bitdiddle' }] })),
    )
    assert(opened.commands ?? []).toEqual([])
    scene(
      { update, view: asAda() },
      given(opened.model),
      expect(role('heading', { level: 1, name: 'A logo for my café' })).toExist(),
      expect(role('heading', { name: 'From Ben Bitdiddle' })).toExist(),
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
  test('shows the request and its stage, their own versions, the change asked for, and a form for the next', () => {
    scene(
      { update, view: asBen() },
      given(showing(bidderPending)),
      expect(role('heading', { level: 1, name: 'A logo for my café' })).toExist(),
      expect(text('Warm colours.')).toExist(),
      expect(text('Open')).toExist(),
      expect(text('The buyer asked for a change to this version')).toExist(),
      expect(role('heading', { name: 'Send a new version' })).toExist(),
    )
  })

  test('shows the worker the fee on what they won and whether each side reviewed, and asks for their review', () => {
    scene(
      { update, view: asBen() },
      given(showing(workerSettled)),
      expect(text('Settled')).toExist(),
      expect(
        text(
          'When the escrow pays you, 5% of the 300.00 USDC you agreed goes to Sidequest: 15.00 USDC. You receive 285.00 USDC.',
        ),
      ).toExist(),
      expect(text('The buyer has reviewed your work.')).toExist(),
      expect(text('You have reviewed the buyer.')).not.toExist(),
      expect(role('heading', { name: 'Review' })).toExist(),
      expect(text('account …000ADA: 5 of 5')).toExist(),
      expect(role('heading', { name: 'Send a new version' })).not.toExist(),
    )
  })

  test('stops asking the worker for a review once they left one', () => {
    const reviewed =
      workerSettled.audience === 'bidder'
        ? {
            ...workerSettled,
            view: {
              ...workerSettled.view,
              reviews: [...workerSettled.view.reviews, { job, author: ben, subject: ada, rating: 4 }],
            },
          }
        : workerSettled
    scene(
      { update, view: asBen() },
      given(showing(reviewed)),
      expect(text('You have reviewed the buyer.')).toExist(),
      expect(role('heading', { name: 'Review' })).not.toExist(),
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
          init('en', job, Option.none(), false, Option.none()).model,
          Message.FailedReadJob({ problem: Problem.NotFound({ reason: 'UnknownJob' }) }),
        ).model,
      ),
      expect(role('heading', { level: 1, name: "This job can't be shown" })).toExist(),
      expect(role('alert')).toContainText('There is no such job.'),
    )
  })
})
