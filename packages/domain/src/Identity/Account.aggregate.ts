import * as Domain from '@alchemy.run/domain'
import { Account as AccountRecord, AccountId } from '@sidequest/protocol'
import { Effect, Predicate, Schema } from 'effect'
import { asPerson } from '../Authority.ts'
import { NotPermitted } from '../NotPermitted.rejection.ts'
import { AlreadyRegistered } from './AlreadyRegistered.rejection.ts'
import { LinkWallet, WalletLinked } from './LinkWallet.command.ts'
import { NotRegistered } from './NotRegistered.rejection.ts'
import { AccountRegistered, RegisterAccount } from './RegisterAccount.command.ts'
import { AccountRenamed, RenameAccount } from './RenameAccount.command.ts'

const Registered = Schema.TaggedStruct('Registered', {
  displayName: AccountRecord.fields.displayName,
  wallets: AccountRecord.fields.wallets,
})
const AccountState = Schema.Union([Schema.TaggedStruct('Unregistered', {}), Registered])
type AccountState = typeof AccountState.Type

const registered = (state: AccountState) =>
  Predicate.isTagged(state, 'Registered') ? Effect.succeed(state) : Effect.fail(new NotRegistered())

/** Only the person who holds the account changes it; their agents may not. */
const asHolder = Effect.fnUntraced(function* (id: AccountId) {
  const account = yield* asPerson()
  if (account !== id) return yield* new NotPermitted({ account, required: 'holder' })
})

/** A person's account: the name others see and the wallets they signed in with. */
export class Account extends Domain.Aggregate('Account', {
  id: AccountId,
  state: AccountState,
  initial: { _tag: 'Unregistered' },
  commands: [RegisterAccount, LinkWallet, RenameAccount],
  decide: {
    RegisterAccount: Effect.fn(function* (state, command, { id }) {
      yield* asHolder(id)
      if (Predicate.isTagged(state, 'Registered')) return yield* new AlreadyRegistered()
      return [new AccountRegistered({ displayName: command.displayName, wallet: command.wallet })]
    }),
    LinkWallet: Effect.fn(function* (state, command, { id }) {
      yield* asHolder(id)
      const account = yield* registered(state)
      return account.wallets.includes(command.wallet) ? [] : [new WalletLinked({ wallet: command.wallet })]
    }),
    RenameAccount: Effect.fn(function* (state, command, { id }) {
      yield* asHolder(id)
      const account = yield* registered(state)
      return account.displayName === command.displayName
        ? []
        : [new AccountRenamed({ displayName: command.displayName })]
    }),
  },
  evolve: {
    AccountRegistered: (_, event) => Registered.make({ displayName: event.displayName, wallets: [event.wallet] }),
    WalletLinked: (state, event) =>
      Predicate.isTagged(state, 'Registered') ? { ...state, wallets: [...state.wallets, event.wallet] } : state,
    AccountRenamed: (state, event) =>
      Predicate.isTagged(state, 'Registered') ? { ...state, displayName: event.displayName } : state,
  },
}) {}
