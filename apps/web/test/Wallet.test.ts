import { it } from '@effect/vitest'
import { TypedData } from '@sidequest/protocol'
import { Effect, Option, Schema } from 'effect'
import { describe, expect } from 'vitest'
import { type Eip1193Provider, hexOfText, makeWallet, NoWallet, WalletFailed, WalletRejected } from '../src/Wallet.ts'

const address = '0x1111111111111111111111111111111111111111'
const signature = `0x${'ab'.repeat(65)}`

type Call = { readonly method: string; readonly params: ReadonlyArray<unknown> }

/** A provider that answers from a table and records what it was asked. A function answer may throw, as wallets reject
 * with an `{ code }` object. */
const fakeProvider = (answers: Readonly<Record<string, (params: ReadonlyArray<unknown>) => unknown>>) => {
  const calls: Array<Call> = []
  const provider: Eip1193Provider = {
    request: async ({ method, params }) => {
      calls.push({ method, params: params ?? [] })
      const answer = answers[method]
      if (answer === undefined) throw rpcError(4200)
      return answer(params ?? [])
    },
  }
  return { provider, calls }
}

/** What a wallet rejects with: an error carrying its EIP-1193 code. */
const rpcError = (code: number) => Object.assign(new Error(`EIP-1193 error ${code}`), { code })

const walletOver = (provider: Eip1193Provider) => makeWallet(Effect.succeed(Option.some(provider)))
const onArc = { eth_requestAccounts: () => [address], eth_chainId: () => '0x4cef52' }

const typedData = Schema.decodeSync(TypedData)({
  domain: { name: 'SidequestOperator', version: '1', chainId: 5042002, verifyingContract: address },
  types: { Approval: [{ name: 'paymentInfoHash', type: 'bytes32' }] },
  primaryType: 'Approval',
  message: { paymentInfoHash: `0x${'00'.repeat(32)}` },
})

describe('the wallet adapter over EIP-1193', () => {
  it.effect('connects: the first account the wallet gives and its chain', () =>
    Effect.gen(function* () {
      const { provider } = fakeProvider(onArc)
      expect(yield* walletOver(provider).connect).toEqual({ address, chainId: 5042002 })
    }),
  )

  it.effect('reports a browser without a wallet', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(makeWallet(Effect.succeed(Option.none())).connect)
      expect(error).toBeInstanceOf(NoWallet)
    }),
  )

  it.effect('reports the person saying no (4001), and any other failure with its code', () =>
    Effect.gen(function* () {
      const refusing = fakeProvider({
        eth_requestAccounts: () => {
          throw rpcError(4001)
        },
      })
      expect(yield* Effect.flip(walletOver(refusing.provider).connect)).toBeInstanceOf(WalletRejected)
      const pending = fakeProvider({
        eth_requestAccounts: () => {
          throw rpcError(-32002)
        },
      })
      expect(yield* Effect.flip(walletOver(pending.provider).connect)).toEqual(new WalletFailed({ code: -32002 }))
    }),
  )

  it.effect('refuses an answer that is not what was asked for', () =>
    Effect.gen(function* () {
      const { provider } = fakeProvider({ ...onArc, personal_sign: () => 'not a signature' })
      expect(yield* Effect.flip(walletOver(provider).signMessage(address, 'hi'))).toBeInstanceOf(WalletFailed)
    }),
  )

  it.effect('adds Arc testnet when the wallet does not know it, then switches to it', () =>
    Effect.gen(function* () {
      const switches: Array<unknown> = []
      const { provider, calls } = fakeProvider({
        wallet_switchEthereumChain: (params) => {
          switches.push(params)
          if (switches.length === 1) throw rpcError(4902)
          return null
        },
        wallet_addEthereumChain: () => null,
      })
      yield* walletOver(provider).switchToArc
      expect(calls.map((call) => call.method)).toEqual([
        'wallet_switchEthereumChain',
        'wallet_addEthereumChain',
        'wallet_switchEthereumChain',
      ])
      expect(calls[1]?.params[0]).toMatchObject({ chainId: '0x4cef52', rpcUrls: ['https://rpc.testnet.arc.io'] })
    }),
  )

  it.effect('signs a sign-in message as UTF-8 hex for the connected account', () =>
    Effect.gen(function* () {
      const { provider, calls } = fakeProvider({ ...onArc, personal_sign: () => signature })
      const message = 'sidequest.test wants you to sign in with your Ethereum account:\nčšž'
      expect(yield* walletOver(provider).signMessage(address, message)).toBe(signature)
      expect(calls[0]).toEqual({ method: 'personal_sign', params: [hexOfText(message), address] })
      expect(hexOfText('čš')).toBe('0xc48dc5a1')
    }),
  )

  it.effect('signs typed data on its domain’s chain, with the EIP712Domain type the wallet hashes it by', () =>
    Effect.gen(function* () {
      const chains = ['0x1', '0x4cef52']
      const { provider, calls } = fakeProvider({
        eth_chainId: () => chains.shift(),
        wallet_switchEthereumChain: () => null,
        eth_signTypedData_v4: () => signature,
      })
      expect(yield* walletOver(provider).signTypedData(address, typedData)).toBe(signature)
      expect(calls.map((call) => call.method)).toEqual([
        'eth_chainId',
        'wallet_switchEthereumChain',
        'eth_signTypedData_v4',
      ])
      const [signer, json] = calls[2]?.params ?? []
      expect(signer).toBe(address)
      expect(JSON.parse(String(json))).toEqual({
        ...typedData,
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' },
          ],
          ...typedData.types,
        },
      })
    }),
  )
})
