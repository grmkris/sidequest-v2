import { it } from '@effect/vitest'
import { story } from './fixtures.ts'

// The pinned @alchemy.run/domain (2.0.0-beta.84) has no `Domain.verify`. Its kernel runs the same definition checks
// (duplicate event tags or names, unknown sources, missing `keyOf`, `on` events no source emits) when the model's layer
// is built, which this story does with every policy and projection.
it.effect('the model is well defined: its layer builds in memory', () => story())
