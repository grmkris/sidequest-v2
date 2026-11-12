import { Story } from '@alchemy.run/domain/Story'
import { it } from '@effect/vitest'
import { Sidequest } from '../src/Sidequest.model.ts'

// The pinned @alchemy.run/domain (2.0.0-beta.84) has no `Domain.verify`. Its kernel runs the same definition checks
// (duplicate event tags or names, unknown sources) when the model's layer is built, which this story does.
it.effect('the model is well defined: its layer builds in memory', () => Story.make(Sidequest)())
