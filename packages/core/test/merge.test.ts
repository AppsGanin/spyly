import { describe, expect, it } from 'vitest'
import { mergeSpeakers, asrFromUtterances, assignSpeakers, clusterFor, containment, mergeTracks, overlap, speakingShares, speakingTime, suppressEcho, textSimilarity, usedSpeakerIds } from '../src/merge.js'
import { timecode } from '../src/format.js'
import { Meeting } from '../src/types.js'
import type { AsrResult, SpeakerTurn, Utterance, Word } from '../src/types.js'

const w = (text: string, start: number, end: number) => ({ text, start, end })

const asr = (track: 'mic' | 'system', words: ReturnType<typeof w>[]): AsrResult => ({
  track,
  language: 'ru',
  segments: [{ text: words.map((x) => x.text).join(' '), start: words[0]?.start ?? 0, end: words.at(-1)?.end ?? 0, words }]
})

describe('overlap', () => {
  it('computes the length of an overlap', () => {
    expect(overlap(0, 10, 5, 15)).toBe(5)
    expect(overlap(0, 10, 10, 20)).toBe(0)
    expect(overlap(0, 10, 11, 20)).toBe(0)
    expect(overlap(2, 4, 0, 10)).toBe(2)
  })
})

describe('clusterFor', () => {
  const turns: SpeakerTurn[] = [
    { start: 0, end: 5, cluster: 0 },
    { start: 5, end: 10, cluster: 1 }
  ]

  it('picks the stretch with the largest overlap', () => {
    expect(clusterFor(1, 2, turns)).toBe(0)
    expect(clusterFor(6, 7, turns)).toBe(1)
  })

  it('a word on a boundary goes where more of it lies', () => {
    expect(clusterFor(4, 6.5, turns)).toBe(1)
    expect(clusterFor(3.5, 5.5, turns)).toBe(0)
  })

  it('a word in a diarization pause is not lost: it goes to the nearest', () => {
    const gapped: SpeakerTurn[] = [
      { start: 0, end: 2, cluster: 0 },
      { start: 8, end: 10, cluster: 1 }
    ]
    expect(clusterFor(3, 3.5, gapped)).toBe(0)
    expect(clusterFor(7, 7.5, gapped)).toBe(1)
  })

  it('with no stretches it returns null', () => {
    expect(clusterFor(0, 1, [])).toBeNull()
  })
})

describe('assignSpeakers', () => {
  it('lays words out by speaker and joins consecutive ones', () => {
    const turns: SpeakerTurn[] = [
      { start: 0, end: 2, cluster: 0 },
      { start: 2, end: 4, cluster: 1 }
    ]
    const out = assignSpeakers(asr('system', [w('привет', 0, 0.5), w('как', 0.6, 1), w('дела', 1.1, 1.6), w('нормально', 2.1, 3)]), turns)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ speakerId: 'system:0', text: 'привет как дела' })
    expect(out[1]).toMatchObject({ speakerId: 'system:1', text: 'нормально' })
  })

  it('breaks an utterance at a long pause by the same speaker', () => {
    const turns: SpeakerTurn[] = [{ start: 0, end: 30, cluster: 0 }]
    const out = assignSpeakers(asr('mic', [w('раз', 0, 0.4), w('два', 0.5, 0.9), w('три', 10, 10.4)]), turns)
    expect(out).toHaveLength(2)
    expect(out[0]!.text).toBe('раз два')
    expect(out[1]!.text).toBe('три')
  })

  it('with no diarization it counts the track as one speaker', () => {
    const out = assignSpeakers(asr('mic', [w('соло', 0, 1)]), [])
    expect(out).toHaveLength(1)
    expect(out[0]!.speakerId).toBe('mic:0')
  })

  it('an empty track gives an empty result rather than a crash', () => {
    expect(assignSpeakers({ track: 'system', language: 'ru', segments: [] }, [])).toEqual([])
  })

  it('works without per-word timestamps, by segment', () => {
    const noWords: AsrResult = {
      track: 'system',
      language: 'ru',
      segments: [
        { text: 'первая фраза', start: 0, end: 2, words: [] },
        { text: 'вторая фраза', start: 2.1, end: 4, words: [] }
      ]
    }
    const turns: SpeakerTurn[] = [
      { start: 0, end: 2, cluster: 0 },
      { start: 2, end: 4, cluster: 1 }
    ]
    const out = assignSpeakers(noWords, turns)
    expect(out.map((u) => u.speakerId)).toEqual(['system:0', 'system:1'])
  })

  it('does not glue a space before punctuation', () => {
    const out = assignSpeakers(asr('mic', [w('да', 0, 0.3), w(',', 0.3, 0.35), w('конечно', 0.4, 1)]), [])
    expect(out[0]!.text).toBe('да, конечно')
  })

  it('throws out empty words', () => {
    const out = assignSpeakers(asr('mic', [w('  ', 0, 0.1), w('текст', 0.2, 0.6)]), [])
    expect(out).toHaveLength(1)
    expect(out[0]!.text).toBe('текст')
  })

  it('marks live-mode drafts', () => {
    const out = assignSpeakers(asr('mic', [w('черновик', 0, 1)]), [], { provisional: true })
    expect(out[0]!.provisional).toBe(true)
  })
})

describe('mergeTracks', () => {
  it('merges the tracks by time', () => {
    const mic = assignSpeakers(asr('mic', [w('я', 0, 1), w('говорю', 4, 5)]), [])
    const sys = assignSpeakers(asr('system', [w('они', 2, 3)]), [])
    const merged = mergeTracks(mic, sys)
    expect(merged.map((u) => u.text)).toEqual(['я', 'они', 'говорю'])
  })

  it('clusters of different tracks do not mix', () => {
    const mic = assignSpeakers(asr('mic', [w('комната', 0, 1)]), [{ start: 0, end: 1, cluster: 0 }])
    const sys = assignSpeakers(asr('system', [w('звонок', 1, 2)]), [{ start: 1, end: 2, cluster: 0 }])
    const merged = mergeTracks(mic, sys)
    expect(usedSpeakerIds(merged)).toEqual(['mic:0', 'system:0'])
  })

  it('empty tracks do not break the merge', () => {
    expect(mergeTracks([], [])).toEqual([])
  })
})

describe('speakingTime', () => {
  it('sums the duration per speaker', () => {
    const turns: SpeakerTurn[] = [
      { start: 0, end: 2, cluster: 0 },
      { start: 2, end: 6, cluster: 1 }
    ]
    const out = assignSpeakers(asr('system', [w('а', 0, 1), w('б', 3, 5)]), turns)
    const t = speakingTime(out)
    expect(t.get('system:0')).toBeCloseTo(1)
    expect(t.get('system:1')).toBeCloseTo(2)
  })
})

describe('suppressEcho', () => {
  const utter = (id: string, track: 'mic' | 'system', start: number, end: number, text: string) => ({
    id,
    speakerId: `${track}:0`,
    track,
    start,
    end,
    text,
    words: [],
    provisional: false
  })

  it('throws out a microphone utterance that repeats the system one', () => {
    const mic = [utter('m1', 'mic', 0.1, 5.0, 'Привет, нам нужно переделать расчёт подписок')]
    const sys = [utter('s1', 'system', 0, 5.1, 'Привет. Нам нужно переделать расчет подписок')]
    expect(suppressEcho(mic, sys)).toHaveLength(0)
  })

  it('keeps your own speech, which is not in the system track', () => {
    const mic = [utter('m1', 'mic', 0, 3, 'Да, я возьму миграцию на себя')]
    const sys = [utter('s1', 'system', 0, 3, 'Нам нужно переделать расчёт подписок')]
    expect(suppressEcho(mic, sys)).toHaveLength(1)
  })

  it('keeps an utterance that matches by words but at another time', () => {
    const mic = [utter('m1', 'mic', 30, 33, 'Привет, нам нужно переделать расчёт')]
    const sys = [utter('s1', 'system', 0, 3, 'Привет, нам нужно переделать расчёт')]
    expect(suppressEcho(mic, sys)).toHaveLength(1)
  })

  it('with no system track it throws out nothing', () => {
    const mic = [utter('m1', 'mic', 0, 3, 'что-то')]
    expect(suppressEcho(mic, [])).toHaveLength(1)
  })

  it('short acknowledgements do not count as echo of a long phrase', () => {
    const mic = [utter('m1', 'mic', 1, 1.6, 'Да')]
    const sys = [utter('s1', 'system', 0, 6, 'Нам нужно переделать расчёт подписок в биллинге до конца недели')]
    expect(suppressEcho(mic, sys)).toHaveLength(1)
  })

  it('catches echo even when the tracks are cut into utterances differently', () => {
    // The microphone broke the phrase in two and shifted it in time, which is what
    // a real divergence between the tracks looks like.
    const mic = [
      utter('m1', 'mic', 5.0, 9.5, 'Хорошо, тогда я займусь интерфейсом'),
      utter('m2', 'mic', 10.0, 12.0, 'и поправлю отчеты')
    ]
    const sys = [utter('s1', 'system', 9.0, 13.0, 'Хорошо. Тогда я займусь интерфейсом и поправлю отчёты.')]
    expect(suppressEcho(mic, sys)).toHaveLength(0)
  })

  it('does not treat a phrase said much later as echo', () => {
    const mic = [utter('m1', 'mic', 60, 64, 'Хорошо, тогда я займусь интерфейсом')]
    const sys = [utter('s1', 'system', 9, 13, 'Хорошо, тогда я займусь интерфейсом')]
    expect(suppressEcho(mic, sys)).toHaveLength(1)
  })
})

describe('containment', () => {
  it('counts the share of words found in the whole', () => {
    expect(containment('займусь интерфейсом', 'тогда я займусь интерфейсом и отчётами')).toBe(1)
    expect(containment('совсем другое дело', 'тогда я займусь интерфейсом')).toBeLessThan(0.4)
  })
  it('an empty part gives zero', () => {
    expect(containment('', 'что-то')).toBe(0)
  })
})

describe('textSimilarity', () => {
  it('ignores case, punctuation and the ё spelling', () => {
    expect(textSimilarity('Ещё раз, привет!', 'еще раз привет')).toBe(1)
  })
  it('different phrases give low similarity', () => {
    expect(textSimilarity('нам нужно переделать биллинг', 'я возьму миграцию базы')).toBeLessThan(0.3)
  })
  it('empty strings do not break the computation', () => {
    expect(textSimilarity('', 'что-то')).toBe(0)
  })
})

describe('timecode', () => {
  it('does not break on Infinity from <audio>', () => {
    expect(timecode(Number.POSITIVE_INFINITY)).toBe('0:00')
    expect(timecode(Number.NaN)).toBe('0:00')
  })
  it('formats hours and minutes', () => {
    expect(timecode(65)).toBe('1:05')
    expect(timecode(3725)).toBe('1:02:05')
  })
})

describe('suppressEcho: short utterances', () => {
  const utter = (id: string, track: 'mic' | 'system', start: number, end: number, text: string) => ({
    id,
    speakerId: `${track}:0`,
    track,
    start,
    end,
    text,
    words: [],
    provisional: false
  })

  it('removes the echo of the first word of their phrase', () => {
    const mic = [utter('m1', 'mic', 0.1, 0.6, 'привет')]
    const sys = [utter('s1', 'system', 0.0, 5.0, 'привет нам нужно переделать расчёт подписок')]
    expect(suppressEcho(mic, sys)).toHaveLength(0)
  })

  it('keeps a short acknowledgement in the middle of their phrase', () => {
    // The "yes" sounds at the third second, so it is an answer rather than an echo of the start.
    const mic = [utter('m1', 'mic', 3.0, 3.4, 'да')]
    const sys = [utter('s1', 'system', 0.0, 6.0, 'нам нужно переделать расчёт да и отчёты тоже')]
    expect(suppressEcho(mic, sys)).toHaveLength(1)
  })

  it('keeps a short utterance that is not in their text', () => {
    const mic = [utter('m1', 'mic', 0.1, 0.6, 'ага')]
    const sys = [utter('s1', 'system', 0.0, 5.0, 'привет нам нужно переделать расчёт')]
    expect(suppressEcho(mic, sys)).toHaveLength(1)
  })
})

describe('suppressEcho: word stumps', () => {
  const utter = (id: string, track: 'mic' | 'system', start: number, end: number, text: string) => ({
    id, speakerId: `${track}:0`, track, start, end, text, words: [], provisional: false
  })

  it('removes the stump of their word over their own speech', () => {
    const mic = [utter('m1', 'mic', 11.0, 11.3, 'займь')]
    const sys = [utter('s1', 'system', 10.0, 14.0, 'хорошо тогда я займусь интерфейсом и поправлю отчёты')]
    expect(suppressEcho(mic, sys)).toHaveLength(0)
  })

  it('leaves a short word that resembles nothing of theirs', () => {
    const mic = [utter('m1', 'mic', 11.0, 11.4, 'угу')]
    const sys = [utter('s1', 'system', 10.0, 14.0, 'хорошо тогда я займусь интерфейсом')]
    expect(suppressEcho(mic, sys)).toHaveLength(1)
  })

  it('leaves a scrap spoken outside their speech', () => {
    const mic = [utter('m1', 'mic', 40.0, 40.4, 'займь')]
    const sys = [utter('s1', 'system', 10.0, 14.0, 'я займусь интерфейсом')]
    expect(suppressEcho(mic, sys)).toHaveLength(1)
  })
})

describe('speakingShares', () => {
  const utter = (id: string, speaker: string, start: number, end: number) => ({
    id, speakerId: speaker, track: 'system' as const, start, end, text: 'x', words: [], provisional: false
  })

  it('counts shares by utterance rather than by recording length', () => {
    const shares = speakingShares([
      utter('1', 'a', 0, 6),
      utter('2', 'b', 10, 12),
      utter('3', 'a', 20, 22)
    ])
    expect(shares[0]!.speakerId).toBe('a')
    expect(shares[0]!.seconds).toBe(8)
    expect(shares[0]!.share).toBeCloseTo(0.8)
    expect(shares[0]!.utterances).toBe(2)
    expect(shares[1]!.share).toBeCloseTo(0.2)
  })

  it('on an empty list it does not divide by zero', () => {
    expect(speakingShares([])).toEqual([])
  })
})

// One person can speak without pauses for minutes: an utterance grew into a
// wall of text a minute and a half long that can neither be read nor quoted.
describe('long utterances', () => {
  const speech = (seconds: number, sentenceEvery: number): Word[] => {
    const words: Word[] = []
    for (let i = 0; i < seconds * 2; i++) {
      const at = i / 2
      const endsSentence = i > 0 && i % (sentenceEvery * 2) === 0
      words.push({ text: endsSentence ? `слово${i}.` : `слово${i}`, start: at, end: at + 0.4 })
    }
    return words
  }

  it('cuts at the end of a sentence rather than mid-phrase', () => {
    const result = assignSpeakers(
      { track: 'mic', language: 'ru', segments: [{ text: '', start: 0, end: 90, words: speech(90, 10) }] },
      [],
      { idPrefix: 'u' }
    )
    expect(result.length).toBeGreaterThan(1)
    // Every utterance but the last ends with a full stop.
    for (const u of result.slice(0, -1)) {
      expect(u.text.trim().endsWith('.'), u.text.slice(-30)).toBe(true)
    }
  })

  it('a short conversation is not broken into scraps', () => {
    const result = assignSpeakers(
      { track: 'mic', language: 'ru', segments: [{ text: '', start: 0, end: 20, words: speech(20, 5) }] },
      [],
      { idPrefix: 'u' }
    )
    expect(result).toHaveLength(1)
  })
})

/**
 * Rebuilding from somewhere other than the start.
 *
 * There was data loss here: processing started "from voice separation"
 * assembled the transcript out of an empty list and erased it entirely, on
 * exactly the button offered by the question "how many people were speaking".
 */
describe('a transcript back into a recognition result', () => {
  const utterance = (
    track: 'mic' | 'system',
    start: number,
    text: string,
    words: Word[]
  ): Utterance => ({
    id: `${track}-${start}`,
    speakerId: `${track}:0`,
    track,
    start,
    end: start + 2,
    text,
    words,
    provisional: false
  })

  it('words with times are carried over as they are', () => {
    const result = asrFromUtterances(
      [
        utterance('system', 0, 'привет мир', [
          { text: 'привет', start: 0, end: 1 },
          { text: 'мир', start: 1, end: 2 }
        ])
      ],
      'ru'
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.track).toBe('system')
    expect(result[0]!.language).toBe('ru')
    expect(result[0]!.segments[0]!.words.map((w) => w.text)).toEqual(['привет', 'мир'])
  })

  it('the tracks do not mix', () => {
    const result = asrFromUtterances(
      [
        utterance('system', 0, 'чужая речь', [{ text: 'чужая', start: 0, end: 1 }]),
        utterance('mic', 5, 'своя речь', [{ text: 'своя', start: 5, end: 6 }])
      ],
      'ru'
    )
    expect(result.map((r) => r.track).sort()).toEqual(['mic', 'system'])
  })

  it('an utterance with no per-word markup is not lost', () => {
    const result = asrFromUtterances([utterance('mic', 3, 'сказал что-то', [])], 'ru')
    const words = result[0]!.segments[0]!.words
    expect(words).toHaveLength(1)
    expect(words[0]).toEqual({ text: 'сказал что-то', start: 3, end: 5 })
  })

  it('the words run in increasing time', () => {
    const result = asrFromUtterances(
      [
        utterance('system', 10, 'позже', [{ text: 'позже', start: 10, end: 11 }]),
        utterance('system', 0, 'раньше', [{ text: 'раньше', start: 0, end: 1 }])
      ],
      'ru'
    )
    const words = result[0]!.segments[0]!.words
    expect(words.map((w) => w.text)).toEqual(['раньше', 'позже'])
    expect(result[0]!.segments[0]!.start).toBe(0)
    expect(result[0]!.segments[0]!.end).toBe(11)
  })

  it('an empty transcript gives an empty list rather than an invention', () => {
    expect(asrFromUtterances([], 'ru')).toEqual([])
  })
})

/**
 * Recognition stretches the last words of a stretch out to its end. On a real
 * recording two short words got 3.5 seconds each and covered ten seconds of
 * silence: no pauses were left between words, the utterance was glued together
 * across the silence and took someone else's time in the speaking statistics.
 */
describe('stretched words', () => {
  const asr = (words: Word[]): AsrResult => ({
    track: 'system',
    language: 'ru',
    segments: [{ text: words.map((w) => w.text).join(' '), start: words[0]!.start, end: words[words.length - 1]!.end, words }]
  })

  it('an utterance is not glued across silence', () => {
    const result = assignSpeakers(
      asr([
        w('до', 60, 60.5),
        w('тишины', 60.5, 61),
        // A word the recogniser stretched over the whole pause.
        w('перед', 61, 71),
        w('после', 71, 71.5),
        w('тишины', 71.5, 72)
      ]),
      []
    )
    expect(result.length).toBe(2)
    expect(result[0]!.end).toBeLessThan(64)
    expect(result[1]!.start).toBeCloseTo(71)
  })

  it('ordinary words are left alone', () => {
    const words = [w('раз', 0, 0.4), w('два', 0.5, 0.9), w('три', 1, 1.4)]
    const result = assignSpeakers(asr(words), [])
    expect(result).toHaveLength(1)
    expect(result[0]!.end).toBeCloseTo(1.4)
  })

  it('an utterance with no per-word markup is not clamped', () => {
    // There is one "word" for the whole stretch, and its duration is meaningful.
    const result = assignSpeakers(
      { track: 'system', language: 'ru', segments: [{ text: 'длинная реплика целиком', start: 0, end: 30, words: [] }] },
      []
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.end).toBe(30)
  })
})

/**
 * Voice separation sometimes breaks one person's speech into several clusters.
 * On a real recording one participant came out as both "Speaker 1" and
 * "Speaker 2", and their share of the conversation was halved.
 */
describe('merging participants', () => {
  const meeting = (): Meeting =>
    Meeting.parse({
      id: '2026-08-28--test--aaaa',
      title: 'Разговор',
      startedAt: '2026-08-28T10:00:00.000Z',
      durationSec: 60,
      sources: { mic: true, system: true },
      speakers: [
        { id: 'system:0', track: 'system', cluster: 0, name: 'Иван', number: 1 },
        { id: 'system:3', track: 'system', cluster: 3, name: 'Иван', number: 2 }
      ],
      utterances: [
        { id: 'u0', speakerId: 'system:0', track: 'system', start: 0, end: 10,
          text: 'первая половина', words: [], provisional: false },
        { id: 'u1', speakerId: 'system:3', track: 'system', start: 10, end: 20,
          text: 'вторая половина', words: [], provisional: false }
      ]
    })

  it('one participant remains and the utterances pass to them', () => {
    const result = mergeSpeakers(meeting(), 'system:3', 'system:0')
    expect(result.speakers).toHaveLength(1)
    expect(result.speakers[0]!.id).toBe('system:0')
    expect(result.utterances.every((u) => u.speakerId === 'system:0')).toBe(true)
  })

  it('the utterances are not lost and do not change order', () => {
    const result = mergeSpeakers(meeting(), 'system:3', 'system:0')
    expect(result.utterances.map((u) => u.text)).toEqual(['первая половина', 'вторая половина'])
  })

  it('merging with itself changes nothing', () => {
    const before = meeting()
    expect(mergeSpeakers(before, 'system:0', 'system:0')).toBe(before)
  })

  it('a target that does not exist changes nothing', () => {
    const before = meeting()
    expect(mergeSpeakers(before, 'system:0', 'system:9')).toBe(before)
  })
})
