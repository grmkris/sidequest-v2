import { describe, expect, it } from 'vitest'
import { tools } from '../src/McpTools.ts'

const hint = (name: string) => tools.find((tool) => tool.name === name)?.annotations

describe('the MCP tools', () => {
  it('take closed inputs, so a model cannot pass what a tool does not know', () => {
    for (const tool of tools) {
      expect({ name: tool.name, schema: tool.inputSchema }).toMatchObject({
        name: tool.name,
        schema: { type: 'object', additionalProperties: false },
      })
      expect({ name: tool.name, short: tool.description.length <= 400 }).toEqual({ name: tool.name, short: true })
    }
  })

  it('say truthfully which only read and which replace or end something', () => {
    expect(hint('pages_list')).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    expect(hint('comments_read')).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    expect(hint('page_publish')).toMatchObject({ readOnlyHint: false, destructiveHint: true })
    expect(hint('link_revoke')).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true })
    expect(hint('page_visibility')).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true })
    expect(hint('comment_reply')).toMatchObject({ readOnlyHint: false, destructiveHint: false })
  })

  it('offer no way to resolve a thread: agents answer, people decide', () => {
    expect(tools.map((tool) => tool.name).some((name) => /resolve|status|delete/u.test(name))).toBe(false)
  })
})
