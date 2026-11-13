import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { chainProfileOf, chainProfiles, chainRefusal, mainnetOptIn, settlementChainOn } from '../src/Chains.ts'
import { arcTestnet } from '../src/SettlementChain.ts'

// The chains a stage can name: Arc testnet settles; a mainnet is representable but refused unless the stage opts in
// with the exact phrase that names it, and a chain without the escrow deployed is refused whatever is set.

const deployment = {
  operator: '0x00000000000000000000000000000000000000a1',
  feeReceiver: '0x00000000000000000000000000000000000000f1',
  arbitrator: '0x00000000000000000000000000000000000a4b17',
}

describe('settlement chains', () => {
  it('reads an unset chain as Arc testnet, an unknown one as none', () => {
    expect(Option.map(chainProfileOf(Option.none()), ({ name }) => name)).toEqual(Option.some('arc-testnet'))
    expect(chainProfileOf(Option.some('base-sepolia'))).toEqual(Option.none())
  })

  it('builds exactly the Arc testnet chain settlement always used', () => {
    expect(settlementChainOn(chainProfiles['arc-testnet'], deployment)).toEqual(Option.some(arcTestnet(deployment)))
    expect(chainRefusal(chainProfiles['arc-testnet'], '')).toBeUndefined()
  })

  it('refuses a mainnet without the phrase that names it, and with another chain’s', () => {
    const base = chainProfiles['base-mainnet']
    expect(mainnetOptIn(base)).toBe('settle real money on base-mainnet (chain 8453)')
    expect(chainRefusal(base, '')).toBe('MainnetNotOptedIn')
    expect(chainRefusal(base, 'yes')).toBe('MainnetNotOptedIn')
    expect(chainRefusal(base, mainnetOptIn(chainProfiles['arc-mainnet']))).toBe('MainnetNotOptedIn')
    expect(chainRefusal(base, mainnetOptIn(base))).toBeUndefined()
  })

  it('refuses Arc mainnet even when opted in: the escrow is not deployed there', () => {
    const arc = chainProfiles['arc-mainnet']
    expect(chainRefusal(arc, mainnetOptIn(arc))).toBe('EscrowNotDeployed')
    expect(settlementChainOn(arc, deployment)).toEqual(Option.none())
  })

  it('gives Base mainnet its own USDC domain and more confirmations', () => {
    const chain = Option.getOrUndefined(settlementChainOn(chainProfiles['base-mainnet'], deployment))
    expect(chain).toMatchObject({
      chainId: 8453,
      token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      tokenDomain: { name: 'USD Coin', version: '2' },
      confirmations: 10,
    })
    expect(chain?.asset.network).toBe('eip155:8453')
  })
})
