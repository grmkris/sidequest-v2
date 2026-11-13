import { Schema } from 'effect'
import { Entropy } from '../src/Entropy.ts'
import { bytesOf } from '../src/Hex.ts'
import { SecretKey } from '../src/Keys.ts'

/** A fixed secret key from 64 hex characters (a test's own constant, so a bad one fails loudly). */
export const secret = (hex: string) => Schema.decodeSync(SecretKey)(hex)

/** 32 fixed bytes from 64 hex characters. */
export const entropy = (hex: string) => Schema.decodeSync(Entropy)(bytesOf(hex))

/** Generated 32-byte values, for keys and randomness in properties. */
export const Hex32 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))

/** A generated secret key: almost every 32-byte value is a valid scalar, and the rest are skipped. */
export const GeneratedSecret = Hex32.check(
  Schema.makeFilter((hex: string) => Schema.is(SecretKey)(hex), { expected: 'secp256k1Scalar' }),
)

/** Generated non-empty text UTF-8 can carry: no unpaired surrogates. */
export const WellFormed = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(2000),
  Schema.isPattern(/^[^\uD800-\uDFFF]*$/u),
)

/** The text with the character at `position` (wrapped to its length) changed to another; empty text gains one. */
export const replaceAt = (text: string, position: number) => {
  const at = position % Math.max(text.length, 1)
  const next = text.charAt(at) === '0' ? '1' : '0'
  return `${text.slice(0, at)}${next}${text.slice(at + 1)}`
}

/** The NIP-59 example's author and recipient. */
export const alice = secret('0beebd062ec8735f4243466049d7747ef5d6594ee838de147f8aab842b15e273')
export const bob = secret('e108399bd8424357a710b606ae0c13166d853d327e47a6e5e038197346bdbf45')
export const zeros = entropy('00'.repeat(32))

/**
 * A kind-1 note by jack (npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m) as relay nos.lol served it
 * on 2026-11-13: signed by an independent client (Primal), with a multi-value tag and a newline in its content.
 */
export const relayNote = {
  content: '\nhttps://blossom.primal.net/e1ab8cda510ec0bcfcb1b98089283509d0b465300a46d7f976bb50165eb7d2e9.jpg',
  created_at: 1778631138,
  id: '900c7d7f528b2e4a133da4f52306c060ba25735435453c613df33608834d6a7a',
  kind: 1,
  pubkey: '82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2',
  sig: '129ab42617a33cda76dfcfde76bbf6dffcdb75ebc187940973cb524b736e0e8c597ea4e6e198f4f5d2ec1b75f73d435350fe31d29988b8510244c60b398d2f4b',
  tags: [
    [
      'imeta',
      'url https://blossom.primal.net/e1ab8cda510ec0bcfcb1b98089283509d0b465300a46d7f976bb50165eb7d2e9.jpg',
      'm jpeg',
      'dim 4284.0x5712.0',
    ],
  ],
}

/**
 * The example HTTP auth event in NIP-98 (nostr-protocol/nips@1fb3a95f, 98.md). Its id is not the hash of its fields
 * (`2dd2dfec…` is), so a verifier that recomputes the id refuses it.
 */
export const nip98Example = {
  id: 'fe964e758903360f28d8424d092da8494ed207cba823110be3a57dfe4b578734',
  pubkey: '63fe6318dc58583cfe16810f86dd09e18bfd76aabc24a0081ce2856f330504ed',
  content: '',
  kind: 27235,
  created_at: 1682327852,
  tags: [
    ['u', 'https://api.snort.social/api/v1/n5sp/list'],
    ['method', 'GET'],
  ],
  sig: '5ed9d8ec958bc854f997bdc24ac337d005af372324747efe4a00e24f4c30437ff4dd8308684bed467d9d6be3e5a517bb43b1732cc7d33949a3aaf86705c22184',
}

/**
 * The example in NIP-59 (nostr-protocol/nips@1fb3a95f, 59.md): `alice` seals a kind-1 rumor to `bob`, and a one-time
 * key wraps the seal. The spec's rumor has no signature, as a rumor must not.
 */
export const nip59Example = {
  rumor: {
    created_at: 1691518405,
    content: 'Are you going to the party tonight?',
    tags: [],
    kind: 1,
    pubkey: '611df01bfcf85c26ae65453b772d8f1dfd25c264621c0277e1fc1518686faef9',
    id: '9dd003c6d3b73b74a85a9ab099469ce251653a7af76f523671ab828acd2a0ef9',
  },
  seal: {
    content:
      'AqBCdwoS7/tPK+QGkPCadJTn8FxGkd24iApo3BR9/M0uw6n4RFAFSPAKKMgkzVMoRyR3ZS/aqATDFvoZJOkE9cPG/TAzmyZvr/WUIS8kLmuI1dCA+itFF6+ULZqbkWS0YcVU0j6UDvMBvVlGTzHz+UHzWYJLUq2LnlynJtFap5k8560+tBGtxi9Gx2NIycKgbOUv0gEqhfVzAwvg1IhTltfSwOeZXvDvd40rozONRxwq8hjKy+4DbfrO0iRtlT7G/eVEO9aJJnqagomFSkqCscttf/o6VeT2+A9JhcSxLmjcKFG3FEK3Try/WkarJa1jM3lMRQqVOZrzHAaLFW/5sXano6DqqC5ERD6CcVVsrny0tYN4iHHB8BHJ9zvjff0NjLGG/v5Wsy31+BwZA8cUlfAZ0f5EYRo9/vKSd8TV0wRb9DQ=',
    kind: 13,
    created_at: 1703015180,
    pubkey: '611df01bfcf85c26ae65453b772d8f1dfd25c264621c0277e1fc1518686faef9',
    tags: [],
    id: '28a87d7c074d94a58e9e89bb3e9e4e813e2189f285d797b1c56069d36f59eaa7',
    sig: '02fc3facf6621196c32912b1ef53bac8f8bfe9db51c0e7102c073103586b0d29c3f39bdaa1e62856c20e90b6c7cc5dc34ca8bb6a528872cf6e65e6284519ad73',
  },
  wrap: {
    content:
      'AhC3Qj/QsKJFWuf6xroiYip+2yK95qPwJjVvFujhzSguJWb/6TlPpBW0CGFwfufCs2Zyb0JeuLmZhNlnqecAAalC4ZCugB+I9ViA5pxLyFfQjs1lcE6KdX3euCHBLAnE9GL/+IzdV9vZnfJH6atVjvBkNPNzxU+OLCHO/DAPmzmMVx0SR63frRTCz6Cuth40D+VzluKu1/Fg2Q1LSst65DE7o2efTtZ4Z9j15rQAOZfE9jwMCQZt27rBBK3yVwqVEriFpg2mHXc1DDwHhDADO8eiyOTWF1ghDds/DxhMcjkIi/o+FS3gG1dG7gJHu3KkGK5UXpmgyFKt+421m5o++RMD/BylS3iazS1S93IzTLeGfMCk+7IKxuSCO06k1+DaasJJe8RE4/rmismUvwrHu/HDutZWkvOAhd4z4khZo7bJLtiCzZCZ74lZcjOB4CYtuAX2ZGpc4I1iOKkvwTuQy9BWYpkzGg3ZoSWRD6ty7U+KN+fTTmIS4CelhBTT15QVqD02JxfLF7nA6sg3UlYgtiGw61oH68lSbx16P3vwSeQQpEB5JbhofW7t9TLZIbIW/ODnI4hpwj8didtk7IMBI3Ra3uUP7ya6vptkd9TwQkd/7cOFaSJmU+BIsLpOXbirJACMn+URoDXhuEtiO6xirNtrPN8jYqpwvMUm5lMMVzGT3kMMVNBqgbj8Ln8VmqouK0DR+gRyNb8fHT0BFPwsHxDskFk5yhe5c/2VUUoKCGe0kfCcX/EsHbJLUUtlHXmTqaOJpmQnW1tZ/siPwKRl6oEsIJWTUYxPQmrM2fUpYZCuAo/29lTLHiHMlTbarFOd6J/ybIbICy2gRRH/LFSryty3Cnf6aae+A9uizFBUdCwTwffc3vCBae802+R92OL78bbqHKPbSZOXNC+6ybqziezwG+OPWHx1Qk39RYaF0aFsM4uZWrFic97WwVrH5i+/Nsf/OtwWiuH0gV/SqvN1hnkxCTF/+XNn/laWKmS3e7wFzBsG8+qwqwmO9aVbDVMhOmeUXRMkxcj4QreQkHxLkCx97euZpC7xhvYnCHarHTDeD6nVK+xzbPNtzeGzNpYoiMqxZ9bBJwMaHnEoI944Vxoodf51cMIIwpTmmRvAzI1QgrfnOLOUS7uUjQ/IZ1Qa3lY08Nqm9MAGxZ2Ou6R0/Z5z30ha/Q71q6meAs3uHQcpSuRaQeV29IASmye2A2Nif+lmbhV7w8hjFYoaLCRsdchiVyNjOEM4VmxUhX4VEvw6KoCAZ/XvO2eBF/SyNU3Of4SO',
    kind: 1059,
    created_at: 1703021488,
    pubkey: '18b1a75918f1f2c90c23da616bce317d36e348bcf5f7ba55e75949319210c87c',
    id: '5c005f3ccf01950aa8d131203248544fb1e41a0d698e846bd419cec3890903ac',
    sig: '35fabdae4634eb630880a1896a886e40fd6ea8a60958e30b89b33a93e6235df750097b04f9e13053764251b8bc5dd7e8e0794a3426a90b6bcc7e5ff660f54259',
    tags: [['p', '166bf3765ebd1fc55decfe395beff2ea3b2a4e0a8946e7eb578512b555737c99']],
  },
}
