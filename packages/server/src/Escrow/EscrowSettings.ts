import { PublicKey } from '@sidequest/nostr'
import { Context, Option, Schema } from 'effect'

type Environment = Readonly<Record<string, unknown>>

/**
 * Who arbitrates on this stage: the Nostr key whose NIP-98 authorization alone may ask for a ruling
 * (`SIDEQUEST_ARBITRATION_PUBKEY`, 64 hex). Without one, rulings answer `Unavailable`.
 */
export interface ArbitrationSettings {
  readonly arbitrationPubkey: Option.Option<PublicKey>
}

/** The stage's escrow settings; unset, no ruling is accepted. */
export const EscrowSettings = Context.Reference<ArbitrationSettings>('Sidequest/Escrow/EscrowSettings', {
  defaultValue: () => ({ arbitrationPubkey: Option.none() }),
})

/** The settings from a Worker's variables. A malformed key reads as none; the deploy refused it already. */
export const escrowSettingsFrom = (environment: Environment): ArbitrationSettings => ({
  arbitrationPubkey: Schema.decodeUnknownOption(PublicKey)(environment['SIDEQUEST_ARBITRATION_PUBKEY']),
})

const Block = Schema.String.check(Schema.isPattern(/^\d{1,15}$/u))

/**
 * The operator's deployment block (`SIDEQUEST_OPERATOR_DEPLOY_BLOCK`), where a new stage's chain log poller starts so
 * that it reads the operator's whole history; unset, it starts at the confirmed head of its first run.
 */
export const operatorDeployBlockFrom = (environment: Environment): Option.Option<bigint> =>
  Option.map(Schema.decodeUnknownOption(Block)(environment['SIDEQUEST_OPERATOR_DEPLOY_BLOCK']), BigInt)
