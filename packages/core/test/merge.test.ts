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
  it('считает длину пересечения', () => {
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

  it('выбирает отрезок с наибольшим пересечением', () => {
    expect(clusterFor(1, 2, turns)).toBe(0)
    expect(clusterFor(6, 7, turns)).toBe(1)
  })

  it('слово на границе уходит туда, где его больше', () => {
    expect(clusterFor(4, 6.5, turns)).toBe(1)
    expect(clusterFor(3.5, 5.5, turns)).toBe(0)
  })

  it('слово в паузе диаризации не теряется — уходит к ближайшему', () => {
    const gapped: SpeakerTurn[] = [
      { start: 0, end: 2, cluster: 0 },
      { start: 8, end: 10, cluster: 1 }
    ]
    expect(clusterFor(3, 3.5, gapped)).toBe(0)
    expect(clusterFor(7, 7.5, gapped)).toBe(1)
  })

  it('без отрезков возвращает null', () => {
    expect(clusterFor(0, 1, [])).toBeNull()
  })
})

describe('assignSpeakers', () => {
  it('разносит слова по спикерам и склеивает подряд идущие', () => {
    const turns: SpeakerTurn[] = [
      { start: 0, end: 2, cluster: 0 },
      { start: 2, end: 4, cluster: 1 }
    ]
    const out = assignSpeakers(asr('system', [w('привет', 0, 0.5), w('как', 0.6, 1), w('дела', 1.1, 1.6), w('нормально', 2.1, 3)]), turns)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ speakerId: 'system:0', text: 'привет как дела' })
    expect(out[1]).toMatchObject({ speakerId: 'system:1', text: 'нормально' })
  })

  it('рвёт реплику на длинной паузе того же спикера', () => {
    const turns: SpeakerTurn[] = [{ start: 0, end: 30, cluster: 0 }]
    const out = assignSpeakers(asr('mic', [w('раз', 0, 0.4), w('два', 0.5, 0.9), w('три', 10, 10.4)]), turns)
    expect(out).toHaveLength(2)
    expect(out[0]!.text).toBe('раз два')
    expect(out[1]!.text).toBe('три')
  })

  it('без диаризации считает дорожку одним говорящим', () => {
    const out = assignSpeakers(asr('mic', [w('соло', 0, 1)]), [])
    expect(out).toHaveLength(1)
    expect(out[0]!.speakerId).toBe('mic:0')
  })

  it('пустая дорожка даёт пустой результат, а не падение', () => {
    expect(assignSpeakers({ track: 'system', language: 'ru', segments: [] }, [])).toEqual([])
  })

  it('работает без пословных таймкодов — по сегментам', () => {
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

  it('не приклеивает пробел перед знаками препинания', () => {
    const out = assignSpeakers(asr('mic', [w('да', 0, 0.3), w(',', 0.3, 0.35), w('конечно', 0.4, 1)]), [])
    expect(out[0]!.text).toBe('да, конечно')
  })

  it('выбрасывает пустые слова', () => {
    const out = assignSpeakers(asr('mic', [w('  ', 0, 0.1), w('текст', 0.2, 0.6)]), [])
    expect(out).toHaveLength(1)
    expect(out[0]!.text).toBe('текст')
  })

  it('помечает черновики live-режима', () => {
    const out = assignSpeakers(asr('mic', [w('черновик', 0, 1)]), [], { provisional: true })
    expect(out[0]!.provisional).toBe(true)
  })
})

describe('mergeTracks', () => {
  it('сливает дорожки по времени', () => {
    const mic = assignSpeakers(asr('mic', [w('я', 0, 1), w('говорю', 4, 5)]), [])
    const sys = assignSpeakers(asr('system', [w('они', 2, 3)]), [])
    const merged = mergeTracks(mic, sys)
    expect(merged.map((u) => u.text)).toEqual(['я', 'они', 'говорю'])
  })

  it('кластеры разных дорожек не смешиваются', () => {
    const mic = assignSpeakers(asr('mic', [w('комната', 0, 1)]), [{ start: 0, end: 1, cluster: 0 }])
    const sys = assignSpeakers(asr('system', [w('звонок', 1, 2)]), [{ start: 1, end: 2, cluster: 0 }])
    const merged = mergeTracks(mic, sys)
    expect(usedSpeakerIds(merged)).toEqual(['mic:0', 'system:0'])
  })

  it('пустые дорожки не ломают слияние', () => {
    expect(mergeTracks([], [])).toEqual([])
  })
})

describe('speakingTime', () => {
  it('суммирует длительность по спикерам', () => {
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

  it('выбрасывает реплику микрофона, повторяющую системную', () => {
    const mic = [utter('m1', 'mic', 0.1, 5.0, 'Привет, нам нужно переделать расчёт подписок')]
    const sys = [utter('s1', 'system', 0, 5.1, 'Привет. Нам нужно переделать расчет подписок')]
    expect(suppressEcho(mic, sys)).toHaveLength(0)
  })

  it('оставляет собственную речь, которой нет в системной дорожке', () => {
    const mic = [utter('m1', 'mic', 0, 3, 'Да, я возьму миграцию на себя')]
    const sys = [utter('s1', 'system', 0, 3, 'Нам нужно переделать расчёт подписок')]
    expect(suppressEcho(mic, sys)).toHaveLength(1)
  })

  it('оставляет реплику, совпавшую по словам, но в другое время', () => {
    const mic = [utter('m1', 'mic', 30, 33, 'Привет, нам нужно переделать расчёт')]
    const sys = [utter('s1', 'system', 0, 3, 'Привет, нам нужно переделать расчёт')]
    expect(suppressEcho(mic, sys)).toHaveLength(1)
  })

  it('без системной дорожки ничего не выбрасывает', () => {
    const mic = [utter('m1', 'mic', 0, 3, 'что-то')]
    expect(suppressEcho(mic, [])).toHaveLength(1)
  })

  it('короткие подтверждения не считаются эхом чужой длинной фразы', () => {
    const mic = [utter('m1', 'mic', 1, 1.6, 'Да')]
    const sys = [utter('s1', 'system', 0, 6, 'Нам нужно переделать расчёт подписок в биллинге до конца недели')]
    expect(suppressEcho(mic, sys)).toHaveLength(1)
  })

  it('ловит эхо, даже когда дорожки нарезаны на реплики по-разному', () => {
    // Микрофон разбил фразу надвое и сдвинул её по времени — так и выглядит
    // реальное расхождение между дорожками.
    const mic = [
      utter('m1', 'mic', 5.0, 9.5, 'Хорошо, тогда я займусь интерфейсом'),
      utter('m2', 'mic', 10.0, 12.0, 'и поправлю отчеты')
    ]
    const sys = [utter('s1', 'system', 9.0, 13.0, 'Хорошо. Тогда я займусь интерфейсом и поправлю отчёты.')]
    expect(suppressEcho(mic, sys)).toHaveLength(0)
  })

  it('не считает эхом фразу, сказанную сильно позже', () => {
    const mic = [utter('m1', 'mic', 60, 64, 'Хорошо, тогда я займусь интерфейсом')]
    const sys = [utter('s1', 'system', 9, 13, 'Хорошо, тогда я займусь интерфейсом')]
    expect(suppressEcho(mic, sys)).toHaveLength(1)
  })
})

describe('containment', () => {
  it('считает долю слов, найденных в целом', () => {
    expect(containment('займусь интерфейсом', 'тогда я займусь интерфейсом и отчётами')).toBe(1)
    expect(containment('совсем другое дело', 'тогда я займусь интерфейсом')).toBeLessThan(0.4)
  })
  it('пустая часть даёт ноль', () => {
    expect(containment('', 'что-то')).toBe(0)
  })
})

describe('textSimilarity', () => {
  it('не различает регистр, пунктуацию и ё', () => {
    expect(textSimilarity('Ещё раз, привет!', 'еще раз привет')).toBe(1)
  })
  it('разные фразы дают низкое сходство', () => {
    expect(textSimilarity('нам нужно переделать биллинг', 'я возьму миграцию базы')).toBeLessThan(0.3)
  })
  it('пустые строки не ломают вычисление', () => {
    expect(textSimilarity('', 'что-то')).toBe(0)
  })
})

describe('timecode', () => {
  it('не ломается на бесконечности из <audio>', () => {
    expect(timecode(Number.POSITIVE_INFINITY)).toBe('0:00')
    expect(timecode(Number.NaN)).toBe('0:00')
  })
  it('форматирует часы и минуты', () => {
    expect(timecode(65)).toBe('1:05')
    expect(timecode(3725)).toBe('1:02:05')
  })
})

describe('suppressEcho: короткие реплики', () => {
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

  it('убирает эхо первого слова чужой фразы', () => {
    const mic = [utter('m1', 'mic', 0.1, 0.6, 'привет')]
    const sys = [utter('s1', 'system', 0.0, 5.0, 'привет нам нужно переделать расчёт подписок')]
    expect(suppressEcho(mic, sys)).toHaveLength(0)
  })

  it('оставляет короткое подтверждение посреди чужой фразы', () => {
    // «да» звучит на третьей секунде — это ответ, а не эхо начала.
    const mic = [utter('m1', 'mic', 3.0, 3.4, 'да')]
    const sys = [utter('s1', 'system', 0.0, 6.0, 'нам нужно переделать расчёт да и отчёты тоже')]
    expect(suppressEcho(mic, sys)).toHaveLength(1)
  })

  it('оставляет короткую реплику, которой нет в чужом тексте', () => {
    const mic = [utter('m1', 'mic', 0.1, 0.6, 'ага')]
    const sys = [utter('s1', 'system', 0.0, 5.0, 'привет нам нужно переделать расчёт')]
    expect(suppressEcho(mic, sys)).toHaveLength(1)
  })
})

describe('suppressEcho: огрызки слов', () => {
  const utter = (id: string, track: 'mic' | 'system', start: number, end: number, text: string) => ({
    id, speakerId: `${track}:0`, track, start, end, text, words: [], provisional: false
  })

  it('убирает обрывок чужого слова поверх его же речи', () => {
    const mic = [utter('m1', 'mic', 11.0, 11.3, 'займь')]
    const sys = [utter('s1', 'system', 10.0, 14.0, 'хорошо тогда я займусь интерфейсом и поправлю отчёты')]
    expect(suppressEcho(mic, sys)).toHaveLength(0)
  })

  it('не трогает короткое слово, не похожее ни на что чужое', () => {
    const mic = [utter('m1', 'mic', 11.0, 11.4, 'угу')]
    const sys = [utter('s1', 'system', 10.0, 14.0, 'хорошо тогда я займусь интерфейсом')]
    expect(suppressEcho(mic, sys)).toHaveLength(1)
  })

  it('не трогает обрывок, прозвучавший вне чужой речи', () => {
    const mic = [utter('m1', 'mic', 40.0, 40.4, 'займь')]
    const sys = [utter('s1', 'system', 10.0, 14.0, 'я займусь интерфейсом')]
    expect(suppressEcho(mic, sys)).toHaveLength(1)
  })
})

describe('speakingShares', () => {
  const utter = (id: string, speaker: string, start: number, end: number) => ({
    id, speakerId: speaker, track: 'system' as const, start, end, text: 'x', words: [], provisional: false
  })

  it('считает доли по репликам, а не по длительности записи', () => {
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

  it('на пустом списке не делит на ноль', () => {
    expect(speakingShares([])).toEqual([])
  })
})

// Один человек может говорить без пауз минутами: реплика вырастала в стену
// текста на полторы минуты, которую нельзя ни прочитать, ни процитировать.
describe('длинные реплики', () => {
  const speech = (seconds: number, sentenceEvery: number): Word[] => {
    const words: Word[] = []
    for (let i = 0; i < seconds * 2; i++) {
      const at = i / 2
      const endsSentence = i > 0 && i % (sentenceEvery * 2) === 0
      words.push({ text: endsSentence ? `слово${i}.` : `слово${i}`, start: at, end: at + 0.4 })
    }
    return words
  }

  it('режет по концу предложения, а не посреди фразы', () => {
    const result = assignSpeakers(
      { track: 'mic', language: 'ru', segments: [{ text: '', start: 0, end: 90, words: speech(90, 10) }] },
      [],
      { idPrefix: 'u' }
    )
    expect(result.length).toBeGreaterThan(1)
    // Каждая реплика, кроме последней, заканчивается точкой.
    for (const u of result.slice(0, -1)) {
      expect(u.text.trim().endsWith('.'), u.text.slice(-30)).toBe(true)
    }
  })

  it('короткий разговор на огрызки не дробит', () => {
    const result = assignSpeakers(
      { track: 'mic', language: 'ru', segments: [{ text: '', start: 0, end: 20, words: speech(20, 5) }] },
      [],
      { idPrefix: 'u' }
    )
    expect(result).toHaveLength(1)
  })
})

/**
 * Пересборка не с самого начала.
 *
 * Здесь была потеря данных: обработка, запущенная «с разделения по голосам»,
 * собирала расшифровку из пустого списка и стирала её целиком — по той самой
 * кнопке, которую предлагает вопрос «сколько человек говорило».
 */
describe('расшифровка обратно в результат распознавания', () => {
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

  it('слова с временами переносятся как есть', () => {
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

  it('дорожки не смешиваются', () => {
    const result = asrFromUtterances(
      [
        utterance('system', 0, 'чужая речь', [{ text: 'чужая', start: 0, end: 1 }]),
        utterance('mic', 5, 'своя речь', [{ text: 'своя', start: 5, end: 6 }])
      ],
      'ru'
    )
    expect(result.map((r) => r.track).sort()).toEqual(['mic', 'system'])
  })

  it('реплика без разметки по словам не теряется', () => {
    const result = asrFromUtterances([utterance('mic', 3, 'сказал что-то', [])], 'ru')
    const words = result[0]!.segments[0]!.words
    expect(words).toHaveLength(1)
    expect(words[0]).toEqual({ text: 'сказал что-то', start: 3, end: 5 })
  })

  it('слова идут по возрастанию времени', () => {
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

  it('пустая расшифровка даёт пустой список, а не выдумку', () => {
    expect(asrFromUtterances([], 'ru')).toEqual([])
  })
})

/**
 * Распознавание растягивает последние слова отрезка до его конца. На настоящей
 * записи «перед» и «тем» получили по 3.5 секунды и накрыли собой десять секунд
 * тишины: между словами не оставалось пауз, реплика склеивалась через молчание
 * и забирала себе чужое время в статистике говорения.
 */
describe('растянутые слова', () => {
  const asr = (words: Word[]): AsrResult => ({
    track: 'system',
    language: 'ru',
    segments: [{ text: words.map((w) => w.text).join(' '), start: words[0]!.start, end: words[words.length - 1]!.end, words }]
  })

  it('реплика не склеивается через тишину', () => {
    const result = assignSpeakers(
      asr([
        w('до', 60, 60.5),
        w('тишины', 60.5, 61),
        // Слово, растянутое распознавателем на всю паузу.
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

  it('обычные слова не трогает', () => {
    const words = [w('раз', 0, 0.4), w('два', 0.5, 0.9), w('три', 1, 1.4)]
    const result = assignSpeakers(asr(words), [])
    expect(result).toHaveLength(1)
    expect(result[0]!.end).toBeCloseTo(1.4)
  })

  it('реплику без разметки по словам не режет', () => {
    // Там одно «слово» на весь отрезок, и его длительность осмысленна.
    const result = assignSpeakers(
      { track: 'system', language: 'ru', segments: [{ text: 'длинная реплика целиком', start: 0, end: 30, words: [] }] },
      []
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.end).toBe(30)
  })
})

/**
 * Разделение по голосам иногда дробит речь одного человека на несколько
 * кластеров. На настоящей записи один собеседник оказался «Участником 1» и
 * «Участником 2», и его доля в разговоре разделилась пополам.
 */
describe('сведение участников', () => {
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

  it('участник остаётся один, реплики переходят к нему', () => {
    const result = mergeSpeakers(meeting(), 'system:3', 'system:0')
    expect(result.speakers).toHaveLength(1)
    expect(result.speakers[0]!.id).toBe('system:0')
    expect(result.utterances.every((u) => u.speakerId === 'system:0')).toBe(true)
  })

  it('реплики не теряются и не меняют порядок', () => {
    const result = mergeSpeakers(meeting(), 'system:3', 'system:0')
    expect(result.utterances.map((u) => u.text)).toEqual(['первая половина', 'вторая половина'])
  })

  it('сведение с самим собой ничего не меняет', () => {
    const before = meeting()
    expect(mergeSpeakers(before, 'system:0', 'system:0')).toBe(before)
  })

  it('несуществующий получатель ничего не меняет', () => {
    const before = meeting()
    expect(mergeSpeakers(before, 'system:0', 'system:9')).toBe(before)
  })
})
