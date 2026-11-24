/**
 * The team from outside Git: `CRIT_TEAM` in the publish-env file (`site.publishEnv`) lists who signs in, as
 * `email=Name,email=Name` (a name is optional). A project that keeps people's addresses out of its repository lists
 * them there and leaves `access.emails` and `names` in crit.config.ts empty; a project may also use both, and the two
 * lists are joined. `deploy` hands the value to the stack.
 */
export interface Team {
  readonly emails: ReadonlyArray<string>
  readonly names: Readonly<Record<string, string>>
}

const EMAIL = /^[^\s@=,]+@[^\s@=,]+\.[^\s@=,]+$/u

/** The people in a `CRIT_TEAM` value. An entry that is not an email address is refused, so a typo never deploys. */
export const parseTeam = (raw: string): Team => {
  const emails: string[] = []
  const names: Record<string, string> = {}
  for (const entry of raw.split(',')) {
    const [address = '', ...rest] = entry.split('=')
    const email = address.trim().toLowerCase()
    if (email === '' && rest.length === 0) continue
    if (!EMAIL.test(email)) throw new Error(`CRIT_TEAM: "${entry.trim()}" is not email=Name`)
    if (!emails.includes(email)) emails.push(email)
    const name = rest.join('=').trim()
    if (name !== '') names[email] = name
  }
  return { emails, names }
}

/** The config's people and `CRIT_TEAM`'s, joined; the config's name wins for an email both list. */
export const joinTeam = (config: Team, raw: string): Team => {
  const extra = parseTeam(raw)
  const lower = config.emails.map((email) => email.toLowerCase())
  return {
    emails: [...lower, ...extra.emails.filter((email) => !lower.includes(email))],
    names: { ...extra.names, ...config.names },
  }
}
