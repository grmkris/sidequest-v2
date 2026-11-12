import { Story } from '@alchemy.run/domain/Story'
import { AccountRef } from '@sidequest/protocol'
import { describe, it } from '@effect/vitest'
import { AgentRevoked } from '../src/AgentRevoked.rejection.ts'
import { CurrentActor } from '../src/CurrentActor.context.ts'
import { ExpiryNotInFuture } from '../src/ExpiryNotInFuture.rejection.ts'
import { Account } from '../src/Identity/Account.aggregate.ts'
import { Agent } from '../src/Identity/Agent.aggregate.ts'
import { AlreadyRegistered } from '../src/Identity/AlreadyRegistered.rejection.ts'
import { AgentGranted, GrantAgent } from '../src/Identity/GrantAgent.command.ts'
import { LinkWallet, WalletLinked } from '../src/Identity/LinkWallet.command.ts'
import { NotRegistered } from '../src/Identity/NotRegistered.rejection.ts'
import { AccountRegistered, RegisterAccount } from '../src/Identity/RegisterAccount.command.ts'
import { AgentRegistered, RegisterAgent } from '../src/Identity/RegisterAgent.command.ts'
import { AccountRenamed, RenameAccount } from '../src/Identity/RenameAccount.command.ts'
import { GrantRevoked, RevokeGrant } from '../src/Identity/RevokeGrant.command.ts'
import { NotPermitted } from '../src/NotPermitted.rejection.ts'
import { PartyRequired } from '../src/PartyRequired.rejection.ts'
import { PersonRequired } from '../src/PersonRequired.rejection.ts'
import { agentOf, alice, aliceAgent, at, bob, person, settlement, story } from './fixtures.ts'

const account = Account.ref(alice)
const agent = Agent.ref(aliceAgent)
const wallet = AccountRef.make('eip155:5042002:0x00000000000000000000000000000000000a11ce')
const secondWallet = AccountRef.make('eip155:5042002:0x00000000000000000000000000000000000a11c3')
const grant = { scopes: ['propose', 'accept'] as const, expiresAt: at.grantExpiry }
const registered = new AccountRegistered({ displayName: 'Alice', wallet })

describe('an account', () => {
  it.effect('is registered with the wallet its holder signed in with, then gains wallets and a new name', () =>
    story(
      Story.provide(CurrentActor, person(alice)),
      Story.when(account, new RegisterAccount({ displayName: 'Alice', wallet })),
      Story.then(account, registered),
      Story.when(account, new LinkWallet({ wallet: secondWallet })),
      Story.then(account, new WalletLinked({ wallet: secondWallet })),
      Story.when(account, new LinkWallet({ wallet })),
      Story.then(account),
      Story.when(account, new RenameAccount({ displayName: 'Alice B.' })),
      Story.then(account, new AccountRenamed({ displayName: 'Alice B.' })),
      Story.when(account, new RenameAccount({ displayName: 'Alice B.' })),
      Story.then(account),
    ),
  )

  it.effect('refuses changes before registration, a second registration, and anyone but its holder in person', () =>
    story(
      Story.provide(CurrentActor, person(alice)),
      Story.when(account, new LinkWallet({ wallet })),
      Story.rejected(new NotRegistered()),
      Story.when(account, new RegisterAccount({ displayName: 'Alice', wallet })),
      Story.then(account, registered),
      Story.when(account, new RegisterAccount({ displayName: 'Alice', wallet })),
      Story.rejected(new AlreadyRegistered()),
      Story.provide(CurrentActor, person(bob)),
      Story.when(account, new RenameAccount({ displayName: 'Mallory' })),
      Story.rejected(new NotPermitted({ account: bob, required: 'holder' })),
      Story.provide(CurrentActor, agentOf(alice, aliceAgent, ['discuss'])),
      Story.when(account, new RenameAccount({ displayName: 'Agent Alice' })),
      Story.rejected(new PersonRequired({ agent: aliceAgent })),
      Story.provide(CurrentActor, settlement),
      Story.when(account, new LinkWallet({ wallet: secondWallet })),
      Story.rejected(new PartyRequired({ system: 'settlement' })),
    ),
  )
})

describe('an agent', () => {
  it.effect('is registered, granted and revoked for good by its operator', () =>
    story(
      Story.provide(CurrentActor, person(alice)),
      Story.when(agent, new RegisterAgent({ name: 'Alice’s scout' })),
      Story.then(agent, new AgentRegistered({ operator: alice, name: 'Alice’s scout' })),
      Story.when(agent, new GrantAgent({ grant })),
      Story.then(agent, new AgentGranted({ grant })),
      Story.when(agent, new RevokeGrant()),
      Story.then(agent, new GrantRevoked()),
      Story.when(agent, new RevokeGrant()),
      Story.then(agent),
      Story.when(agent, new GrantAgent({ grant })),
      Story.rejected(new AgentRevoked({ agent: aliceAgent })),
    ),
  )

  it.effect('refuses grants from anyone but its operator in person, before registration, or already expired', () =>
    story(
      Story.provide(CurrentActor, person(alice)),
      Story.when(agent, new GrantAgent({ grant })),
      Story.rejected(new NotRegistered()),
      Story.when(agent, new RegisterAgent({ name: 'Scout' })),
      Story.then(agent, new AgentRegistered({ operator: alice, name: 'Scout' })),
      Story.when(agent, new RegisterAgent({ name: 'Scout' })),
      Story.rejected(new AlreadyRegistered()),
      Story.when(agent, new GrantAgent({ grant: { ...grant, expiresAt: at.start } })),
      Story.rejected(new ExpiryNotInFuture({ expiresAt: at.start, now: at.start })),
      Story.provide(CurrentActor, person(bob)),
      Story.when(agent, new RevokeGrant()),
      Story.rejected(new NotPermitted({ account: bob, required: 'operator' })),
      Story.provide(CurrentActor, agentOf(alice, aliceAgent, ['discuss', 'propose', 'accept', 'deliver'])),
      Story.when(agent, new GrantAgent({ grant })),
      Story.rejected(new PersonRequired({ agent: aliceAgent })),
    ),
  )
})
