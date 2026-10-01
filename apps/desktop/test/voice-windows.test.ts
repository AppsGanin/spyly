import { describe, expect, it } from 'vitest'
import { joinWindows, windowsFromSpeech, wordsFromTokens } from '../src/main/providers/asr/voice-windows'

describe('windows of speech', () => {
  it('puts phrases separated by short pauses into one window', () => {
    const windows = windowsFromSpeech([
      { start: 0, end: 3 },
      { start: 3.5, end: 7 },
      { start: 7.4, end: 9 }
    ])
    expect(windows).toEqual([{ start: 0, end: 9 }])
  })

  it('breaks on a pause long enough to end a thought', () => {
    const windows = windowsFromSpeech([
      { start: 0, end: 3 },
      { start: 4.2, end: 6 }
    ])
    expect(windows).toEqual([
      { start: 0, end: 3 },
      { start: 4.2, end: 6 }
    ])
  })

  it('never lets a window grow past the limit', () => {
    const phrases = Array.from({ length: 12 }, (_, i) => ({ start: i * 4, end: i * 4 + 3.6 }))
    const windows = windowsFromSpeech(phrases)
    for (const window of windows) expect(window.end - window.start).toBeLessThanOrEqual(20)
    // Nothing is lost on the way: the windows cover every phrase.
    expect(windows[0]!.start).toBe(0)
    expect(windows[windows.length - 1]!.end).toBe(47.6)
  })

  it('keeps a single phrase longer than the limit whole rather than cutting it mid-word', () => {
    expect(windowsFromSpeech([{ start: 0, end: 23 }])).toEqual([{ start: 0, end: 23 }])
  })

  it('has nothing to say about silence', () => {
    expect(windowsFromSpeech([])).toEqual([])
  })
})

describe('words from the model pieces', () => {
  // Pieces exactly as GigaAM returned them on a real recording.
  const tokens = [' П', 'е', 'ре', 'ры', 'в', ' ', '—', ' это', ' в', ' о', 'с', 'но', 'в', 'но', 'м']
  const times = [0, 0.12, 0.2, 0.28, 0.4, 0.48, 0.56, 0.64, 0.76, 0.88, 0.92, 1.0, 1.08, 1.2, 1.32]

  it('gives back the text the model wrote, word for word', () => {
    const words = wordsFromTokens(tokens, times, 0, 2)!
    expect(words.map((w) => w.text)).toEqual(['Перерыв', '—', 'это', 'в', 'основном'])
  })

  it('times a word from its first piece, shifted to where the window starts', () => {
    const words = wordsFromTokens(tokens, times, 960, 962)!
    expect(words[0]!.start).toBe(960)
    expect(words[2]!.start).toBeCloseTo(960.64)
  })

  it('ends a word where it stops sounding, not where the next one begins', () => {
    // "Перерыв" ends with the piece at 0.4; the next word is at 0.56.
    const words = wordsFromTokens(tokens, times, 0, 2)!
    expect(words[0]!.end).toBeCloseTo(0.55)
    expect(words[0]!.end).toBeLessThanOrEqual(words[1]!.start)
  })

  it('leaves a real pause between words for the transcript to split on', () => {
    const words = wordsFromTokens([' Да', ' нет'], [0, 3], 0, 4)!
    expect(words[1]!.start - words[0]!.end).toBeGreaterThan(2.5)
  })

  it('keeps the last word inside the window', () => {
    const words = wordsFromTokens([' Да'], [0.95], 0, 1)!
    expect(words[0]!.end).toBe(1)
  })

  it('makes one full stop of the two the model sometimes writes, and leaves an ellipsis', () => {
    const words = wordsFromTokens([' добавим', '..', ' ну', '...'], [0, 0.4, 1, 1.2], 0, 2)!
    expect(words.map((w) => w.text)).toEqual(['добавим.', 'ну...'])
  })

  it('refuses pieces and times that do not line up', () => {
    expect(wordsFromTokens([' Да', ' нет'], [0], 0, 1)).toBeNull()
    expect(wordsFromTokens([], [], 0, 1)).toBeNull()
  })
})

describe('joining windows', () => {
  const word = (text: string, start: number, end = start + 0.3) => ({ text, start, end })

  it('puts back the full stop the model leaves off at a real pause', () => {
    const words = joinWindows([[word('отработал', 0)], [word('То', 2), word('есть', 2.4)]])
    expect(words.map((w) => w.text)).toEqual(['отработал.', 'То', 'есть.'])
  })

  it('does not break a sentence where the window was only cut for length', () => {
    const words = joinWindows([[word('потому', 0), word('что', 0.4)], [word('Своё', 1), word('приложение', 1.4)]])
    expect(words.map((w) => w.text)).toEqual(['потому', 'что', 'Своё', 'приложение.'])
  })

  it('leaves punctuation the model already put there alone', () => {
    const words = joinWindows([[word('Понимаешь', 0), word('мысль?', 0.5)], [word('Да,', 3)], [word('ну', 6)]])
    expect(words.map((w) => w.text)).toEqual(['Понимаешь', 'мысль?', 'Да,', 'ну.'])
  })

  it('treats a closing quote after the stop as closed', () => {
    const words = joinWindows([[word('«готово.»', 0)], [word('Дальше', 3)]])
    expect(words[0]!.text).toBe('«готово.»')
  })

  it('skips windows the model heard nothing in', () => {
    expect(joinWindows([[], [word('Да', 1)], []]).map((w) => w.text)).toEqual(['Да.'])
  })
})
