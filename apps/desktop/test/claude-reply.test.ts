import { describe, expect, it } from 'vitest'
import { claudeReply } from '../src/main/providers/llm/cli'

describe('an answer from Claude Code', () => {
  it('says which model wrote it, not the small one doing housekeeping beside it', () => {
    const reply = claudeReply(
      JSON.stringify({
        type: 'result',
        is_error: false,
        result: '  {"tldr": "итог"}  ',
        modelUsage: {
          'claude-haiku-4-5-20251001': { outputTokens: 12 },
          'claude-opus-5': { outputTokens: 900 }
        }
      })
    )
    expect(reply).toEqual({ text: '{"tldr": "итог"}', model: 'claude-opus-5' })
  })

  it('turns an error into words rather than into a summary', () => {
    const output = JSON.stringify({ is_error: true, result: 'Invalid model name' })
    expect(() => claudeReply(output)).toThrow('Invalid model name')
  })

  it('keeps plain text from an older version that prints no JSON', () => {
    expect(claudeReply('просто текст')).toEqual({ text: 'просто текст' })
  })
})
