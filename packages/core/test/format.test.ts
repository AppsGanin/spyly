import { describe, expect, it } from 'vitest'
import { renderTranscriptMarkdown, speakerLabel } from '../src/format.js'
import { Meeting, Speaker } from '../src/types.js'

function meeting(marks: { at: number; note?: string }[]): Meeting {
  return Meeting.parse({
    id: '2026-08-28--test--aaaa',
    title: 'Разговор',
    startedAt: '2026-08-28T10:00:00.000Z',
    durationSec: 60,
    sources: { mic: true, system: true },
    marks: marks.map((m, i) => ({ id: `m${i}`, at: m.at, note: m.note })),
    speakers: [{ id: 'system:0', track: 'system', cluster: 0, name: 'Мария' }],
    utterances: [
      { id: 'u0', speakerId: 'system:0', track: 'system', start: 0, end: 5,
        text: 'первая реплика', words: [], provisional: false },
      { id: 'u1', speakerId: 'system:0', track: 'system', start: 20, end: 25,
        text: 'вторая реплика', words: [], provisional: false }
    ]
  })
}

describe('разметка отмеченных мест', () => {
  /**
   * A person places a mark a second or two after the thing was said, so there is
   * no exact landing inside an utterance's bounds: the nearest one is taken.
   */
  it('к отметке подставляется ближайшая реплика', () => {
    const text = renderTranscriptMarkdown(meeting([{ at: 6 }]))
    expect(text).toContain('первая реплика')
  })

  it('отметка ближе ко второй реплике берёт вторую', () => {
    const text = renderTranscriptMarkdown(meeting([{ at: 18 }]))
    const line = text.split('\n').find((l) => l.includes('0:18'))
    expect(line).toContain('вторая реплика')
  })

  it('отметка внутри реплики берёт именно её', () => {
    const text = renderTranscriptMarkdown(meeting([{ at: 22 }]))
    const line = text.split('\n').find((l) => l.includes('0:22'))
    expect(line).toContain('вторая реплика')
  })

  it('пояснение человека важнее текста реплики', () => {
    const text = renderTranscriptMarkdown(meeting([{ at: 3, note: 'вот это важно' }]))
    const line = text.split('\n').find((l) => l.includes('0:03'))
    expect(line).toContain('вот это важно')
    expect(line).not.toContain('первая реплика')
  })

  it('без отметок раздела нет', () => {
    expect(renderTranscriptMarkdown(meeting([]))).not.toContain('Отмеченные места')
  })
})

describe('подпись участника', () => {
  it('имя важнее всего', () => {
    expect(speakerLabel(Speaker.parse({ id: 'system:0', track: 'system', cluster: 0, name: 'Мария' }), 'system:0'))
      .toBe('Мария')
  })

  it('своя речь называется «Вы»', () => {
    expect(speakerLabel(Speaker.parse({ id: 'mic:0', track: 'mic', cluster: 0, isMe: true }), 'mic:0')).toBe('Вы')
  })

  it('без имени — номер по дорожке', () => {
    expect(speakerLabel(Speaker.parse({ id: 'system:1', track: 'system', cluster: 1 }), 'system:1')).toBe('Участник 2')
    expect(speakerLabel(Speaker.parse({ id: 'mic:1', track: 'mic', cluster: 1 }), 'mic:1')).toBe('В комнате 2')
  })

  it('неизвестный участник показывается своим идентификатором', () => {
    expect(speakerLabel(undefined, 'system:7')).toBe('system:7')
  })
})
