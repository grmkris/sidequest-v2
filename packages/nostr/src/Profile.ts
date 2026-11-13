import type { UnixSeconds } from '@sidequest/protocol'
import { Option, Result, Schema } from 'effect'
import type { EventTemplate } from './Event.ts'
import type { PublicKey } from './Keys.ts'
import { standardKinds } from './Kinds.ts'
import { VocabularyRefused } from './SidequestEvent.ts'
import { verifyEvent } from './Verify.ts'

const Name = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(100))

// Other clients write all sorts into kind 0; only the names are read, and a bad one is dropped, not fatal.
const ProfileJson = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.optionalKey(Schema.Unknown),
    display_name: Schema.optionalKey(Schema.Unknown),
  }),
)

/** What Sidequest reads of someone's NIP-01 profile (kind 0): who it is and the name they chose. */
export interface ProfileName {
  readonly pubkey: PublicKey
  readonly name: Option.Option<string>
  readonly displayName: Option.Option<string>
}

const nameOf = (value: unknown) => Schema.decodeUnknownOption(Name)(value)

/** Reads the names from a verified kind-0 event; refuses one that does not verify or whose content is not JSON. */
export const parseProfileName = (input: unknown): Result.Result<ProfileName, VocabularyRefused> =>
  Result.flatMap(
    Result.mapError(verifyEvent(input), () => new VocabularyRefused({ reason: 'invalidEvent' })),
    (event) => {
      if (event.kind !== standardKinds.profile) return Result.fail(new VocabularyRefused({ reason: 'wrongKind' }))
      return Result.mapBoth(Schema.decodeUnknownResult(ProfileJson)(event.content), {
        onFailure: () => new VocabularyRefused({ reason: 'badContent' }),
        onSuccess: (profile) => ({
          pubkey: event.pubkey,
          name: nameOf(profile.name),
          displayName: nameOf(profile.display_name),
        }),
      })
    },
  )

/** A kind-0 profile carrying just a name. Kind 0 is replaceable, so this replaces any richer profile on the relay. */
export const profileTemplate = (name: string, createdAt: UnixSeconds): EventTemplate => ({
  created_at: createdAt,
  kind: standardKinds.profile,
  tags: [],
  content: JSON.stringify({ name }),
})
