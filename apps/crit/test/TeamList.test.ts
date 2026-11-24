import { describe, expect, it } from 'vitest'
import { joinTeam, parseTeam } from '../team.ts'

describe('the team from CRIT_TEAM', () => {
  it('reads emails with optional names', () => {
    expect(parseTeam('Ana@Example.com=Ana, bo@example.com , cy@example.com=Cy = Q')).toEqual({
      emails: ['ana@example.com', 'bo@example.com', 'cy@example.com'],
      names: { 'ana@example.com': 'Ana', 'cy@example.com': 'Cy = Q' },
    })
  })

  it('is empty for an empty value', () => {
    expect(parseTeam('')).toEqual({ emails: [], names: {} })
    expect(parseTeam(' , ')).toEqual({ emails: [], names: {} })
  })

  it('refuses an entry that is not an email', () => {
    expect(() => parseTeam('ana@example.com=Ana,Bo')).toThrow('CRIT_TEAM: "Bo" is not email=Name')
    expect(() => parseTeam('=Ana')).toThrow('is not email=Name')
  })

  it('joins the config with the file, once each, the config naming first', () => {
    const config = { emails: ['Ana@example.com'], names: { 'ana@example.com': 'Ana K' } }
    expect(joinTeam(config, 'ana@example.com=Ana,bo@example.com=Bo')).toEqual({
      emails: ['ana@example.com', 'bo@example.com'],
      names: { 'ana@example.com': 'Ana K', 'bo@example.com': 'Bo' },
    })
  })
})
