import { Story } from '@alchemy.run/domain/Story'
import { AccountRef } from '@sidequest/protocol'
import { describe, it } from '@effect/vitest'
import { system } from '../src/Actor.ts'
import { CurrentActor } from '../src/CurrentActor.context.ts'
import { ClaimWallet, NotReserved, WalletClaimed } from '../src/Identity/ClaimWallet.command.ts'
import { ReservationHeld, ReserveWallet, WalletReserved } from '../src/Identity/ReserveWallet.command.ts'
import { WalletClaim } from '../src/Identity/WalletClaim.aggregate.ts'
import { WalletTaken } from '../src/Identity/WalletTaken.rejection.ts'
import { SystemOnly } from '../src/SystemOnly.rejection.ts'
import { agentOf, alice, aliceAgent, at, bob, iso, person, story } from './fixtures.ts'

const wallet = WalletClaim.ref(AccountRef.make('eip155:5042002:0x00000000000000000000000000000000000A11cE'))
const signIn = system('sign-in')
// A reservation made at the start of a story holds for five minutes.
const heldUntil = at.start + 300

describe('a wallet claim', () => {
  it.effect('links a wallet to the first account that reserves and claims it, and to no other', () =>
    story(
      Story.provide(CurrentActor, signIn),
      Story.when(wallet, new ReserveWallet({ account: alice })),
      Story.then(wallet, new WalletReserved({ account: alice, until: heldUntil })),
      Story.when(wallet, new ReserveWallet({ account: bob })),
      Story.rejected(new ReservationHeld({ account: alice, until: heldUntil })),
      Story.when(wallet, new ReserveWallet({ account: alice })),
      Story.then(wallet),
      Story.when(wallet, new ClaimWallet({ account: bob })),
      Story.rejected(new NotReserved({ account: bob })),
      Story.when(wallet, new ClaimWallet({ account: alice })),
      Story.then(wallet, new WalletClaimed({ account: alice })),
      Story.when(wallet, new ClaimWallet({ account: alice })),
      Story.then(wallet),
      Story.when(wallet, new ReserveWallet({ account: bob })),
      Story.rejected(new WalletTaken({ account: alice })),
      Story.when(wallet, new ClaimWallet({ account: bob })),
      Story.rejected(new WalletTaken({ account: alice })),
      Story.when(wallet, new ReserveWallet({ account: alice })),
      Story.then(wallet),
    ),
  )

  it.effect('lets another account take a reservation that lapsed, and refuses the lapsed one its claim', () =>
    story(
      Story.provide(CurrentActor, signIn),
      Story.when(wallet, new ReserveWallet({ account: alice })),
      Story.then(wallet, new WalletReserved({ account: alice, until: heldUntil })),
      Story.clock(iso(heldUntil - 1)),
      Story.when(wallet, new ReserveWallet({ account: bob })),
      Story.rejected(new ReservationHeld({ account: alice, until: heldUntil })),
      Story.clock(iso(heldUntil)),
      Story.when(wallet, new ReserveWallet({ account: bob })),
      Story.then(wallet, new WalletReserved({ account: bob, until: heldUntil + 300 })),
      Story.when(wallet, new ClaimWallet({ account: alice })),
      Story.rejected(new NotReserved({ account: alice })),
      Story.when(wallet, new ClaimWallet({ account: bob })),
      Story.then(wallet, new WalletClaimed({ account: bob })),
    ),
  )

  it.effect('refuses a claim without a reservation', () =>
    story(
      Story.provide(CurrentActor, signIn),
      Story.when(wallet, new ClaimWallet({ account: alice })),
      Story.rejected(new NotReserved({ account: alice })),
    ),
  )

  it.effect('is changed only by the system, after sign-in verified the wallet’s signature', () =>
    story(
      Story.provide(CurrentActor, person(alice)),
      Story.when(wallet, new ReserveWallet({ account: alice })),
      Story.rejected(new SystemOnly({ account: alice })),
      Story.provide(CurrentActor, agentOf(alice, aliceAgent, ['discuss'])),
      Story.when(wallet, new ClaimWallet({ account: alice })),
      Story.rejected(new SystemOnly({ account: alice })),
    ),
  )
})
