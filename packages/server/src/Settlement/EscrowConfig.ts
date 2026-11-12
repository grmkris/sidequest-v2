import { AccountId } from '@sidequest/protocol'
import { arcTestnet, type SettlementChain } from '@sidequest/settlement/SettlementChain'
import { Option, Redacted, Schema } from 'effect'
import { type Hex, isAddress, isHex } from 'viem'

/**
 * What settlement runs with: the chain (with the deployed operator, the treasury and the interim arbitrator), the
 * relayer's key, the interim arbitrator's key, and the one account that may issue rulings with it in phase 1.
 */
export interface EscrowConfig {
  readonly chain: SettlementChain
  readonly relayerKey: Redacted.Redacted<Hex>
  readonly arbitratorKey: Option.Option<Redacted.Redacted<Hex>>
  readonly arbitrationOperator: Option.Option<AccountId>
}

const text = (environment: Readonly<Record<string, unknown>>, name: string) => {
  const value = environment[name]
  return typeof value === 'string' && value.length > 0 ? Option.some(value) : Option.none()
}
const address = (environment: Readonly<Record<string, unknown>>, name: string) =>
  Option.filter(text(environment, name), (value) => isAddress(value, { strict: false }))
const key = (environment: Readonly<Record<string, unknown>>, name: string) =>
  Option.map(
    Option.filter(text(environment, name), (value): value is Hex => isHex(value) && value.length === 66),
    (value) => Redacted.make(value),
  )
const count = (environment: Readonly<Record<string, unknown>>, name: string) =>
  Option.getOrUndefined(Option.filter(Option.map(text(environment, name), Number), Number.isSafeInteger))

/**
 * Settlement's configuration from the Worker's environment, if it is complete. `SidequestOperator` is not deployed
 * yet, so until `SIDEQUEST_OPERATOR_ADDRESS`, `SIDEQUEST_TREASURY_ADDRESS`, `SIDEQUEST_ARBITRATOR_ADDRESS` and the
 * secret `SIDEQUEST_RELAYER_KEY` are all set, there is none: funding endpoints answer `Unavailable` and the saga
 * reads nothing. Optional: `SIDEQUEST_FEE_BPS` (500), `SIDEQUEST_CONFIRMATIONS` (3), the secret
 * `SIDEQUEST_ARBITRATOR_KEY` and `SIDEQUEST_ARBITRATION_OPERATOR`, the account id allowed to issue rulings.
 */
export const escrowConfigFrom = (environment: Readonly<Record<string, unknown>>): Option.Option<EscrowConfig> =>
  Option.map(
    Option.all({
      operator: address(environment, 'SIDEQUEST_OPERATOR_ADDRESS'),
      feeReceiver: address(environment, 'SIDEQUEST_TREASURY_ADDRESS'),
      arbitrator: address(environment, 'SIDEQUEST_ARBITRATOR_ADDRESS'),
      relayerKey: key(environment, 'SIDEQUEST_RELAYER_KEY'),
    }),
    ({ relayerKey, ...deployment }) => {
      const feeBps = count(environment, 'SIDEQUEST_FEE_BPS')
      const confirmations = count(environment, 'SIDEQUEST_CONFIRMATIONS')
      return {
        chain: arcTestnet({
          ...deployment,
          ...(feeBps === undefined ? {} : { feeBps }),
          ...(confirmations === undefined ? {} : { confirmations }),
        }),
        relayerKey,
        arbitratorKey: key(environment, 'SIDEQUEST_ARBITRATOR_KEY'),
        arbitrationOperator: Option.flatMap(text(environment, 'SIDEQUEST_ARBITRATION_OPERATOR'), (id) =>
          Schema.decodeUnknownOption(AccountId)(id),
        ),
      }
    },
  )
