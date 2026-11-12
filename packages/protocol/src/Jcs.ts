import { Predicate, Result, Schema } from 'effect'

/** A value RFC 8785 cannot represent: a non-finite number or a string with an unpaired surrogate. */
export class NotCanonicalizable extends Schema.TaggedError<NotCanonicalizable>()('NotCanonicalizable', {
  reason: Schema.Literals(['nonFiniteNumber', 'unpairedSurrogate']),
}) {}

// `Array.isArray` narrows to `any[]`; this keeps the element type.
const isJsonArray = (value: Schema.JsonArray | Schema.JsonObject): value is Schema.JsonArray => Array.isArray(value)

const unpairedSurrogate = /[\uD800-\uDFFF]/u

// RFC 8785 §3.2.3 sorts keys by their UTF-16 code units, which is how `<` compares strings.
const byCodeUnits = ([a]: readonly [string, unknown], [b]: readonly [string, unknown]) => (a < b ? -1 : a > b ? 1 : 0)

const problem = (value: Schema.Json): NotCanonicalizable['reason'] | undefined => {
  if (Predicate.isNumber(value)) return Number.isFinite(value) ? undefined : 'nonFiniteNumber'
  if (Predicate.isString(value)) return unpairedSurrogate.test(value) ? 'unpairedSurrogate' : undefined
  if (value === null || Predicate.isBoolean(value)) return undefined
  const children: ReadonlyArray<Schema.Json> = isJsonArray(value)
    ? value
    : Object.entries(value).flatMap(([key, child]) => [key, child])
  for (const child of children) {
    const found = problem(child)
    if (found !== undefined) return found
  }
  return undefined
}

// ECMAScript's JSON.stringify serializes primitives exactly as RFC 8785 §3.2.2 requires: the
// shortest round-tripping number form, -0 as 0, and the minimal string escapes in lowercase hex.
const serialize = (value: Schema.Json): string => {
  if (value === null || Predicate.isBoolean(value) || Predicate.isNumber(value) || Predicate.isString(value)) {
    return JSON.stringify(value)
  }
  if (isJsonArray(value)) return `[${value.map(serialize).join(',')}]`
  const members = Object.entries(value).toSorted(byCodeUnits)
  return `{${members.map(([key, child]) => `${JSON.stringify(key)}:${serialize(child)}`).join(',')}}`
}

/** The RFC 8785 JSON Canonicalization Scheme serialization of a JSON value. */
export const canonicalize = (value: Schema.Json): Result.Result<string, NotCanonicalizable> => {
  const found = problem(value)
  return found === undefined ? Result.succeed(serialize(value)) : Result.fail(new NotCanonicalizable({ reason: found }))
}
