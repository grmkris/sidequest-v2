import { PublicKey } from '@sidequest/nostr'
import { Context, Option, Schema } from 'effect'

type Environment = Readonly<Record<string, unknown>>

/**
 * How Nostr-native settlement runs on this stage: the Nostr key whose NIP-98 authorization alone may ask for a ruling
 * (`SIDEQUEST_ARBITRATION_PUBKEY`, 64 hex). Without one, rulings on Nostr-native jobs answer `Unavailable`. Phase 1's
 * `SIDEQUEST_ARBITRATION_OPERATOR` (an account) stays for phase 1's jobs only.
 */
export interface NativeConfig {
  readonly arbitrationPubkey: Option.Option<PublicKey>
}

/** The stage's settings for Nostr-native settlement; unset, no ruling is accepted. */
export const NativeSettings = Context.Reference<NativeConfig>('Sidequest/Native/NativeSettings', {
  defaultValue: () => ({ arbitrationPubkey: Option.none() }),
})

/** The settings from a Worker's variables. A malformed key reads as none; the deploy refused it already. */
export const nativeConfigFrom = (environment: Environment): NativeConfig => ({
  arbitrationPubkey: Schema.decodeUnknownOption(PublicKey)(environment['SIDEQUEST_ARBITRATION_PUBKEY']),
})

const Block = Schema.String.check(Schema.isPattern(/^\d{1,15}$/u))

/**
 * The operator's deployment block (`SIDEQUEST_OPERATOR_DEPLOY_BLOCK`), where a new stage's chain log poller starts so
 * that it reads the operator's whole history; unset, it starts at the confirmed head of its first run.
 */
export const operatorDeployBlockFrom = (environment: Environment): Option.Option<bigint> =>
  Option.map(Schema.decodeUnknownOption(Block)(environment['SIDEQUEST_OPERATOR_DEPLOY_BLOCK']), BigInt)
