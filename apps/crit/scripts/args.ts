/** A command line as its words, its bare flags (`--revoke`) and its flags that take a value (`--days 7`). */
export interface Args {
  readonly words: ReadonlyArray<string>
  readonly flags: ReadonlySet<string>
  readonly values: ReadonlyMap<string, string>
}

export const parseArgs = (args: ReadonlyArray<string>, valued: ReadonlyArray<string>): Args => {
  const words: string[] = []
  const flags = new Set<string>()
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ''
    if (valued.includes(arg)) {
      // A valued flag with nothing after it is kept as an empty value, for the command to refuse.
      values.set(arg, args[index + 1] ?? '')
      index++
    } else if (arg.startsWith('--')) {
      flags.add(arg)
    } else {
      words.push(arg)
    }
  }
  return { words, flags, values }
}
