import { SessionView } from '@sidequest/protocol'
import { defineTaggedUnion } from 'foldkit/schema'
import { Problem } from './Problem.ts'

/** Who the browser is signed in as, as last read from `/api/session`. Until it is read, `Checking`. */
export const Session = defineTaggedUnion({
  Checking: {},
  SignedOut: {},
  SignedIn: { session: SessionView },
  SigningOut: { session: SessionView },
  Unknown: { problem: Problem },
})
export type Session = typeof Session.Type

/** The wallet address of a signed-in session: the CAIP-10 account's last part. */
export const addressOf = (view: SessionView): string => view.wallet.slice(view.wallet.lastIndexOf(':') + 1)
