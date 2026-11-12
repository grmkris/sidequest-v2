import {
  change,
  Command,
  expect,
  expectOutMessage,
  given,
  label,
  role,
  scene,
  submit,
  text,
  type,
  withViewInputs,
} from 'foldkit/scene'
import { describe, test } from 'vitest'
import { init, Message, OutMessage, PostRequest, update, view } from '../../src/page/NewRequest.ts'
import { Problem } from '../../src/Problem.ts'
import { Session } from '../../src/Session.ts'
import { adaSession, job } from '../Fixtures.ts'

const signedIn = withViewInputs(view, { session: Session.SignedIn({ session: adaSession }) })

describe('posting a request', () => {
  test('asks a signed-out visitor to sign in first and come back', () => {
    scene(
      { update, view: withViewInputs(view, { session: Session.SignedOut() })() },
      given(init('en')),
      expect(role('link', { name: 'Sign in' })).toHaveAttr('href', '/sign-in?next=%2Frequests%2Fnew'),
      expect(label('What do you need?')).not.toExist(),
    )
  })

  test('checks the fields, posts the request open for the days picked, and opens its job', () => {
    scene(
      { update, view: signedIn() },
      given(init('en')),
      submit(role('form')),
      Command.expectNone(),
      expect(label('What do you need?')).toHaveAttr('aria-invalid', 'true'),
      type(label('What do you need?'), '  A logo for my café '),
      type(label('Details'), 'Warm colours.'),
      change(label('Open for proposals'), '14'),
      submit(role('form')),
      expect(role('button', { name: 'Posting…' })).toBeDisabled(),
      Command.resolve(
        PostRequest({ title: 'A logo for my café', description: 'Warm colours.', days: '14' }),
        Message.SucceededPostRequest({ job }),
      ),
      expectOutMessage(OutMessage.Posted({ job })),
    )
  })

  test('says why the server refused, and keeps what was typed', () => {
    scene(
      { update, view: signedIn() },
      given(init('en')),
      type(label('What do you need?'), 'A logo'),
      type(label('Details'), 'Warm colours.'),
      submit(role('form')),
      Command.resolve(PostRequest, Message.FailedPostRequest({ problem: Problem.NotSignedIn() })),
      expect(role('alert')).toContainText('You are not signed in, or your session has ended.'),
      expect(label('What do you need?')).toHaveValue('A logo'),
      expect(text('Post the request')).toExist(),
    )
  })
})
