import { Option } from 'effect'

/**
 * Runs a noble primitive that signals bad input (a point off the curve, a scalar out of range, a malformed signature)
 * by throwing, and answers `None` instead. Only this module catches: everything above it is total.
 */
export const attempt = <A>(run: () => A): Option.Option<A> => {
  try {
    return Option.some(run())
  } catch {
    return Option.none()
  }
}
