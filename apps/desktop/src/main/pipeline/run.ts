import { existsSync } from 'node:fs'
import { t,
  Summary,
  applyIdentification,
  assignSpeakers,
  buildSummaryPrompt,
  asrFromUtterances,
  buildTitlePrompt,
  cleanTitle,
  isAutoTitle,
  identifySpeakers,
  isLikelyHallucination,
  stripHallucination,
  levelAt,
  mergeSpeakers,
  mergeTracks,
  micIsOnlyEcho,
  keepOwnVoice,
  trimEchoedStart,
  SILENCE_RMS_THRESHOLD,
  suppressEcho,
  type AsrResult,
  type Meeting,
  type Speaker,
  type SpeakerTurn,
  type Stage,
  type TrackId,
  type Word
} from '@spyly/core'
import { Notification } from 'electron'
import { send, showMainWindow } from '../index.js'
import { getDiarizationProvider, getLlmProvider, providerForModel } from '../providers/registry.js'
import { forgetHistory } from '../store/history.js'
import type { LlmProvider } from '../providers/types.js'
import { preferredModel } from '../providers/asr/whisper-cpp.js'
import { embedSpeaker, readWave } from '../providers/diarization/sherpa.js'
import { levelWindows, readWavPcm16, speechSeconds } from '../audio/wav.js'
import { readMeeting, updateMeeting, writeMeeting } from '../store/meetings.js'
import { audioFile } from '../store/paths.js'
import { loadSettings } from '../store/settings.js'
import { listVoices } from '../store/voices.js'

const running = new Set<string>()

function report(meetingId: string, stage: string, state: 'running' | 'done' | 'failed', progress?: number, message?: string): void {
  send('stage:progress', { meetingId, stage, state, progress, message })
}

/**
 * Полная обработка записи: расшифровка → разделение по голосам → узнавание
 * участников → конспект.
 *
 * Этапы независимы и отмечаются в meta.json, поэтому упавшую расшифровку можно
 * перезапустить, не трогая всё остальное и уж точно не переписывая созвон.
 */
export async function processMeeting(meetingId: string, from: Stage = 'transcribing'): Promise<void> {
  if (running.has(meetingId)) return
  running.add(meetingId)
  try {
    await runStages(meetingId, from)
  } finally {
    running.delete(meetingId)
  }
}

export function isProcessing(meetingId: string): boolean {
  return running.has(meetingId)
}

async function runStages(meetingId: string, from: Stage): Promise<void> {
  let meeting = await readMeeting(meetingId)
  if (!meeting) throw new Error(t('встреча не найдена'))

  // Обработка перепишет расшифровку заново, и прошлые правки к ней уже не
  // относятся: отмена вернула бы реплики, которых в новой расшифровке нет.
  forgetHistory(meetingId)

  const settings = await loadSettings()
  const order: Stage[] = ['transcribing', 'diarizing', 'identifying', 'summarizing']
  const startAt = Math.max(0, order.indexOf(from))

  // Прошлая ошибка к новому запуску отношения не имеет: оставлять её на экране
  // значит показывать красное «прервалось» рядом с идущей работой.
  const restarting = order.slice(startAt)
  meeting = await updateMeeting(meetingId, (current) => {
    const errors = { ...current.errors }
    for (const stage of restarting) delete errors[stage]
    return {
      ...current,
      stages: { ...current.stages, ...Object.fromEntries(restarting.map((s) => [s, 'pending'])) },
      errors
    }
  })

  const tracks: TrackId[] = (['mic', 'system'] as const).filter((t) => existsSync(audioFile(meetingId, t)))
  if (tracks.length === 0) {
    await save(meeting, { stages: { transcribing: 'failed' }, errors: { transcribing: t('нет файлов записи') } })
    return
  }

  // Начиная не с расшифровки, слова берём из уже готовой: без этого пересборка
  // «с разделения по голосам» собирала расшифровку из пустоты и стирала её —
  // ровно по той кнопке, которую предлагает вопрос «сколько человек говорило».
  let asrResults: AsrResult[] = startAt > order.indexOf('transcribing') ? asrFromUtterances(meeting.utterances, meeting.language) : []
  let turnsByTrack = new Map<TrackId, SpeakerTurn[]>()

  for (let i = startAt; i < order.length; i++) {
    const stage = order[i]!
    try {
      meeting = (await readMeeting(meetingId)) ?? meeting
      report(meetingId, stage, 'running', 0)
      await save(meeting, { stages: { [stage]: 'running' } })

      if (stage === 'transcribing') {
        asrResults = await transcribeTracks(meetingId, tracks, settings.asrModel, settings.language)
        // Записываем, чем именно расшифровано: через месяц по расшифровке
        // непонятно, лёгкой моделью её делали или самой точной.
        meeting = await save(meeting, {
          providers: { ...meeting.providers, asr: settings.asrModel || preferredModel() }
        })
      } else if (stage === 'diarizing') {
        turnsByTrack = await diarizeTracks(
          meetingId,
          tracks,
          settings.diarizationProvider,
          meeting.speakerCount
        )
        meeting = await buildTranscript(meetingId, asrResults, turnsByTrack)
      } else if (stage === 'identifying') {
        meeting = await identify(meetingId)
      } else if (stage === 'summarizing') {
        // Конспект необязателен. Если модель не настроена — это не сбой
        // расшифровки, а просто несделанный шаг: пугать красным незачем.
        const provider = settings.autoSummarize ? getLlmProvider(settings.llmProvider) : null
        const status = provider ? await provider.ready().catch(() => ({ ready: false })) : { ready: false }
        if (status.ready) {
          meeting = await summarize(meetingId, settings.llmProvider)
          meeting = await save(meeting, {
            providers: { ...meeting.providers, llm: provider?.name ?? settings.llmProvider }
          })
        } else {
          // Конспект не просили — но назвать запись по смыслу всё равно стоит:
          // это один короткий запрос, а список из десятка «Записей 28 августа»
          // не даёт найти нужный разговор.
          const namer = getLlmProvider(settings.llmProvider)
          if (namer && (await namer.ready().catch(() => ({ ready: false }))).ready) {
            meeting = await nameMeeting(meetingId, namer)
          }
          await save(meeting, { stages: { summarizing: 'skipped' } })
          report(meetingId, stage, 'done', 1)
          send('meetings:changed', { id: meetingId })
          continue
        }
      }

      meeting = (await readMeeting(meetingId)) ?? meeting
      meeting = await save(meeting, { stages: { [stage]: 'done' } })
      report(meetingId, stage, 'done', 1)
      send('meetings:changed', { id: meetingId })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      meeting = (await readMeeting(meetingId)) ?? meeting
      await save(meeting, {
        stages: { [stage]: 'failed' },
        errors: { [stage]: message }
      })
      report(meetingId, stage, 'failed', undefined, message)
      send('meetings:changed', { id: meetingId })
      // Дальше идти незачем: конспект без расшифровки бессмыслен.
      return
    }
  }

  meeting = await save(meeting, { stages: { done: 'done' } })
  send('meetings:changed', { id: meetingId })
  notifyReady(meeting)
}


/**
 * Сообщить, что запись готова.
 *
 * Обработка идёт минуты, и человек к этому моменту обычно уже занят другим:
 * без уведомления он узнаёт о готовой расшифровке, только когда сам вспомнит
 * заглянуть.
 */
function notifyReady(meeting: Meeting): void {
  if (!Notification.isSupported()) return
  const parts: string[] = []
  if (meeting.utterances.length > 0) parts.push(t('{meeting_utterances_length} реплик', { meeting_utterances_length: meeting.utterances.length }))
  if (meeting.summary) parts.push(t('конспект собран'))
  if (meeting.marks.length > 0) parts.push(t('отмечено мест: {meeting_marks_length}', { meeting_marks_length: meeting.marks.length }))

  const notification = new Notification({
    title: meeting.title,
    body: parts.length > 0 ? `Готово — ${parts.join(', ')}` : t('Обработка закончена'),
    silent: true
  })
  notification.on('click', () => {
    showMainWindow()
    send('view:meeting', { id: meeting.id })
  })
  notification.show()
}

/**
 * Сохранить изменение этапа.
 *
 * Обязательно через `updateMeeting`, а не записью снимка: конвейер держит
 * запись в памяти минутами, и за это время её успевают поменять — остановка
 * записи проставляет «готово» первому этапу, человек правит расшифровку,
 * агент дописывает задачу. Запись снимком затирала всё это молча: у одной
 * записи «Запись» так и осталась крутиться, хотя всё уже было готово.
 */
async function save(meeting: Meeting, patch: Partial<Meeting>): Promise<Meeting> {
  return updateMeeting(meeting.id, (current) => ({
    ...current,
    ...patch,
    // Этапы и ошибки сливаем, а не заменяем: в patch приходит только тот этап,
    // который сейчас менялся.
    stages: { ...current.stages, ...patch.stages },
    errors: { ...current.errors, ...patch.errors }
  }))
}

async function transcribeTracks(
  meetingId: string,
  tracks: TrackId[],
  modelId: string,
  language: string
): Promise<AsrResult[]> {
  // Движок определяется выбранной моделью: человек выбирает качество, а не
  // движок — сравнить их на глаз всё равно нельзя.
  const provider = providerForModel(modelId)
  const status = await provider.ready()
  if (!status.ready) throw new Error(`расшифровка недоступна: ${status.hint ?? t('провайдер не готов')}`)

  const out: AsrResult[] = []
  for (const [index, track] of tracks.entries()) {
    const file = audioFile(meetingId, track)

    // Пустую дорожку в распознавание не отдаём вовсе: на тишине Whisper
    // выдаёт титры из обучающих данных вместо признания, что речи нет.
    const wave = await readWavPcm16(file).catch(() => null)
    if (!wave || speechSeconds(wave.samples, wave.sampleRate) < 0.5) {
      out.push({ track, language, segments: [] })
      continue
    }

    const result = await provider.transcribe(file, track, {
      language,
      onProgress: (p) => report(meetingId, 'transcribing', 'running', (index + p) / tracks.length)
    })
    out.push(result)
  }
  return out
}

/** Средняя энергия участка записи — по ней видно, была ли там речь на самом деле. */
/**
 * Самое громкое место внутри отрезка.
 *
 * Средняя громкость по всей реплике не годится: реплика склеивается из
 * нескольких фраз, между ними паузы, и они размывают речь до нуля. На реальной
 * записи «привет всем, как у вас дела, у меня всё нормально» — три фразы за
 * десять секунд — дали среднее 0.0058 при пороге 0.006, и живая речь была
 * отброшена как тишина. Вопрос ведь не «громко ли в среднем», а «звучала ли
 * здесь речь вообще».
 */
function loudestSecond(samples: Float32Array, sampleRate: number, from: number, to: number): number {
  const start = Math.max(0, Math.floor(from * sampleRate))
  const end = Math.min(samples.length, Math.ceil(to * sampleRate))
  if (end <= start) return 0

  const window = Math.max(1, Math.floor(sampleRate * 0.5))
  let loudest = 0
  for (let at = start; at < end; at += window) {
    const stop = Math.min(end, at + window)
    let sum = 0
    for (let i = at; i < stop; i++) sum += samples[i]! * samples[i]!
    loudest = Math.max(loudest, Math.sqrt(sum / (stop - at)))
  }
  return loudest
}

/**
 * Дорожки диаризуются независимо.
 *
 * Кластер 0 микрофона и кластер 0 системного звука — разные люди, смешивать их
 * нельзя. Зато один человек не может оказаться в обеих дорожках сразу, поэтому
 * и сопоставлять кластеры между дорожками не требуется.
 */
async function diarizeTracks(
  meetingId: string,
  tracks: TrackId[],
  providerId: string,
  speakerCount?: number
): Promise<Map<TrackId, SpeakerTurn[]>> {
  const provider = getDiarizationProvider(providerId)
  const status = await provider.ready()
  if (!status.ready) throw new Error(`разделение по голосам недоступно: ${status.hint ?? t('провайдер не готов')}`)

  const out = new Map<TrackId, SpeakerTurn[]>()
  for (const [index, track] of tracks.entries()) {
    report(meetingId, 'diarizing', 'running', index / tracks.length)
    // Число участников, если его назвали, задаём жёстко. Делим пополам между
    // дорожками с запасом: на микрофоне сидят те, кто в комнате, в системном
    // звуке — удалённые, и точного деления заранее не знает никто.
    const perTrack = speakerCount
      ? Math.max(1, Math.min(speakerCount, tracks.length > 1 ? Math.ceil(speakerCount / 2) + 1 : speakerCount))
      : undefined
    const turns = await provider.diarize(audioFile(meetingId, track), { numSpeakers: perTrack })
    out.set(track, turns)
  }
  return out
}

/**
 * Отчёт о том, что и почему не попало в расшифровку.
 *
 * Фильтров по дороге несколько, и когда реплика пропадает, глазами по коду не
 * понять, который из них сработал. Включается `SPYLY_DIAG_FILTERS=1`.
 */
function dropped(utterance: { start: number; end: number; text: string }, why: string): false {
  if (process.env.SPYLY_DIAG_FILTERS) {
    process.stderr.write(
      `[отсев] ${utterance.start.toFixed(1)}-${utterance.end.toFixed(1)} (${why}): ` +
        `${utterance.text.slice(0, 70)}\n`
    )
  }
  return false
}

/**
 * Заменить текст реплики, оставив слова согласованными с ним.
 *
 * Слова несут времена, и по ним потом раскладывают речь по говорящим. Если
 * оставить их как были, в реплике останутся слова, которых в тексте уже нет.
 * Идём по словам подряд и берём те, что находятся в новом тексте дальше
 * предыдущего, — выброшенные просто не находятся.
 */
function withText<T extends { text: string; words: Word[]; start: number; end: number }>(
  utterance: T,
  text: string
): T {
  const target = text.toLowerCase()
  const words: Word[] = []
  let cursor = 0
  for (const word of utterance.words) {
    const at = target.indexOf(word.text.toLowerCase(), cursor)
    if (at === -1) continue
    words.push(word)
    cursor = at + word.text.length
  }
  return {
    ...utterance,
    text,
    words,
    start: words[0]?.start ?? utterance.start,
    end: words[words.length - 1]?.end ?? utterance.end
  }
}

async function buildTranscript(
  meetingId: string,
  asrResults: AsrResult[],
  turnsByTrack: Map<TrackId, SpeakerTurn[]>
): Promise<Meeting> {
  const meeting = await readMeeting(meetingId)
  if (!meeting) throw new Error(t('встреча не найдена'))

  const byTrack = new Map<TrackId, ReturnType<typeof assignSpeakers>>()
  for (const asr of asrResults) {
    const utterances = assignSpeakers(asr, turnsByTrack.get(asr.track) ?? [])

    // Отсев выдумок: по тексту и по звуку под репликой. Одного текста мало —
    // модель иногда сочиняет правдоподобную фразу; одной энергии тоже, потому
    // что титры попадаются и поверх тихой речи.
    const wave = await readWavPcm16(audioFile(meetingId, asr.track)).catch(() => null)
    const cleaned = utterances
      .map((u) => {
        if (!isLikelyHallucination(u.text)) return u
        // Подпись субтитров липнет к краю реплики и раньше утаскивала за собой
        // всю живую речь: на реальной записи «Субтитры делал DimaTorzok»
        // унесла тридцать семь секунд разговора. Вырезаем подпись, а не реплику.
        const text = stripHallucination(u.text)
        if (!text || text === u.text || isLikelyHallucination(text)) {
          dropped(u, 'выдумка')
          return null
        }
        if (process.env.SPYLY_DIAG_FILTERS) {
          process.stderr.write(`[очистка] ${u.start.toFixed(1)}: убрана подпись, речь оставлена\n`)
        }
        return withText(u, text)
      })
      .filter((u): u is NonNullable<typeof u> => u !== null)
      .filter((u) => {
        if (!wave) return true
        const level = loudestSecond(wave.samples, wave.sampleRate, u.start, u.end)
        if (level < SILENCE_RMS_THRESHOLD) return dropped(u, `тишина под текстом, ${level.toFixed(4)}`)
        return true
      })
    byTrack.set(asr.track, cleaned)
  }

  /*
   * Без наушников микрофон слышит собеседника из колонок.
   *
   * Сравнение текстов тут ненадёжно: распознавание двух дорожек расходится, и
   * на реальной записи по тексту узнавалось лишь три эха из пяти. Поэтому
   * сначала смотрим на громкость — путь «динамики → микрофон» ослабляет звук
   * в разы, и это видно однозначно.
   */
  {
    const micWave = await readWavPcm16(audioFile(meetingId, 'mic')).catch(() => null)
    const systemWave = await readWavPcm16(audioFile(meetingId, 'system')).catch(() => null)
    const micUtterances = byTrack.get('mic') ?? []

    if (micWave && systemWave && micUtterances.length > 0) {
      const micLevels = levelWindows(micWave.samples, micWave.sampleRate)
      const systemLevels = levelWindows(systemWave.samples, systemWave.sampleRate)

      if (micIsOnlyEcho(micLevels, systemLevels)) {
        // Человек молчал всю запись: микрофонная дорожка — сплошное эхо, и
        // всё, что из неё вышло, было бы приписано ему по ошибке.
        byTrack.set('mic', [])
      } else {
        const systemUtterances = byTrack.get('system') ?? []
        const levels = {
          mic: (from: number, to: number) => levelAt(micLevels, from, to),
          system: (from: number, to: number) => levelAt(systemLevels, from, to)
        }

        const kept = micUtterances
          .map((u) => {
            const own = keepOwnVoice(u, levels)
            if (!own) {
              const mine = levelAt(micLevels, u.start, u.end)
              const theirs = levelAt(systemLevels, u.start, u.end)
              dropped(u, `эхо по уровню: микрофон ${mine.toFixed(3)}, динамики ${theirs.toFixed(3)}`)
              return null
            }
            if (own !== u && process.env.SPYLY_DIAG_FILTERS) {
              process.stderr.write(
                `[очистка] ${u.start.toFixed(1)}: срезано эхо, осталось «${own.text.slice(0, 50)}»\n`
              )
            }
            return own
          })
          .filter((u): u is NonNullable<typeof u> => u !== null)
          // Последнее слово собеседника нередко приклеивается к началу вашей
          // реплики: куски двух дорожек нарезаются по-разному.
          .map((u) => {
            const previous = systemUtterances
              .filter((s) => s.end <= u.start + 0.5)
              .sort((a, b) => b.end - a.end)[0]
            return trimEchoedStart(u, previous ? { text: previous.text, end: previous.end } : null, levels)
          })
          .filter((u) => u.text.trim().length > 0)

        byTrack.set('mic', kept)
      }
    }
  }

  // Что осталось — досеиваем по тексту: эхо бывает и громким, когда динамики
  // выкручены.
  const systemUtterances = byTrack.get('system') ?? []
  const beforeEcho = byTrack.get('mic') ?? []
  const micUtterances = suppressEcho(beforeEcho, systemUtterances)
  for (const u of beforeEcho) {
    if (!micUtterances.includes(u)) dropped(u, 'эхо по тексту')
  }
  const utterances = mergeTracks(micUtterances, systemUtterances)

  // Участников берём из реплик, а не из отрезков диаризации: после снятия эха
  // часть кластеров микрофона исчезает, и они не должны остаться в списке
  // участников пустыми строками.
  const speakers: Speaker[] = []
  // Спикер мог остаться без отрезков диаризации — например, дорожка целиком
  // отдана одному говорящему; тогда он появляется только в репликах.
  for (const u of utterances) {
    if (speakers.some((s) => s.id === u.speakerId)) continue
    const [track, cluster] = u.speakerId.split(':')
    speakers.push({
      id: u.speakerId,
      track: (track as TrackId) ?? 'system',
      cluster: Number(cluster ?? 0),
      isMe: false,
      nameSource: 'none'
    })
  }

  // Реплики уже упорядочены по времени, поэтому нумерация идёт по первому
  // появлению — так «Участник 2» и правда второй в разговоре.
  const counters = new Map<TrackId, number>()
  for (const speaker of speakers) {
    const next = (counters.get(speaker.track) ?? 0) + 1
    counters.set(speaker.track, next)
    speaker.number = next
  }

  const next: Meeting = { ...meeting, speakers, utterances }
  await writeMeeting(next)
  return next
}

/** Подставить имена постоянных участников по слепкам голоса. */
async function identify(meetingId: string): Promise<Meeting> {
  const meeting = await readMeeting(meetingId)
  if (!meeting) throw new Error(t('встреча не найдена'))

  const profiles = await listVoices()
  if (profiles.length === 0 || meeting.speakers.length === 0) return meeting

  const clusters: { speakerId: string; embedding: number[]; ownTrack: boolean }[] = []
  for (const track of new Set(meeting.speakers.map((s) => s.track))) {
    const file = audioFile(meetingId, track)
    if (!existsSync(file)) continue
    const wave = await readWave(file)
    // Слепок снимаем по репликам участника, а не по отрезкам разделения.
    // После снятия эха это уже не одно и то же: часть отрезков осталась без
    // реплик, и по ним слепок либо не считался вовсе, либо считался по чужой
    // речи. На реальной записи второй кластер микрофона из-за этого не получал
    // слепка и оставался безымянным, хотя по репликам узнавался на 0.502.
    const turns = meeting.utterances
      .filter((u) => u.track === track)
      .map((u) => ({ start: u.start, end: u.end, cluster: Number(u.speakerId.split(':')[1] ?? 0) }))

    for (const speaker of meeting.speakers.filter((s) => s.track === track)) {
      const embedding = embedSpeaker(wave.samples, wave.sampleRate, turns, speaker.cluster)
      // Микрофонная дорожка — это тот, кто сидит за компьютером: для своего
      // слепка порог узнавания там мягче.
      if (embedding) clusters.push({ speakerId: speaker.id, embedding, ownTrack: track === 'mic' })
    }
  }

  const matches = identifySpeakers(clusters, profiles)
  const identified = applyIdentification(meeting.speakers, matches)
  const next = mergeSameSpeaker({ ...meeting, speakers: identified })
  await writeMeeting(next)
  return next
}

/**
 * Свести кластеры, опознанные как один и тот же человек.
 *
 * Разделение по голосам может разбить речь одного человека на несколько
 * кластеров. Пока они безымянные, это видно только как лишние «Участник 4» и
 * «В комнате 6»; но если оба опознались по одному слепку, держать их порознь
 * незачем — в списке участников человек двоился, а его доля в разговоре
 * делилась пополам.
 */
function mergeSameSpeaker(meeting: Meeting): Meeting {
  const keep = new Map<string, string>()
  const remap = new Map<string, string>()

  for (const speaker of meeting.speakers) {
    if (!speaker.name || speaker.nameSource !== 'voice-match') continue
    // Один и тот же человек не может оказаться сразу на двух дорожках, поэтому
    // сводим только внутри одной.
    const key = `${speaker.track}:${speaker.name}`
    const first = keep.get(key)
    if (first === undefined) keep.set(key, speaker.id)
    else remap.set(speaker.id, first)
  }
  if (remap.size === 0) return meeting

  let out = meeting
  for (const [from, to] of remap) out = mergeSpeakers(out, from, to)
  return out
}

async function summarize(meetingId: string, providerId: string): Promise<Meeting> {
  const meeting = await readMeeting(meetingId)
  if (!meeting) throw new Error(t('встреча не найдена'))
  if (meeting.utterances.length === 0) return meeting

  const provider = getLlmProvider(providerId)
  if (!provider) throw new Error(t('неизвестный провайдер: {providerId}', { providerId: providerId }))
  const status = await provider.ready()
  if (!status.ready) throw new Error(`конспект недоступен: ${status.hint ?? t('провайдер не готов')}`)

  report(meetingId, 'summarizing', 'running', 0.2)
  const raw = await provider.complete([{ role: 'user', content: buildSummaryPrompt(meeting) }], { maxTokens: 3000 })
  const summary = parseSummary(raw, provider.id)

  report(meetingId, 'summarizing', 'running', 0.8)
  await writeMeeting({ ...meeting, summary })
  return nameMeeting(meetingId, provider)
}

/**
 * Назвать запись по смыслу разговора.
 *
 * Название, данное человеком, не трогаем никогда — только то, что приложение
 * придумало само: «Запись 28 августа, 14:27» ничего не говорит о разговоре, и
 * в списке из десятка таких нужную не найти.
 */
async function nameMeeting(meetingId: string, provider: LlmProvider): Promise<Meeting> {
  const meeting = await readMeeting(meetingId)
  if (!meeting) throw new Error(t('встреча не найдена'))
  if (!meeting.titleAuto && !isAutoTitle(meeting.title)) return meeting
  if (meeting.utterances.length === 0) return meeting

  const suggested = await provider
    .complete([{ role: 'user', content: buildTitlePrompt(meeting) }], { maxTokens: 60 })
    .catch(() => '')
  const title = cleanTitle(suggested)
  if (!title) return meeting

  const next: Meeting = { ...meeting, title, titleAuto: false }
  await writeMeeting(next)
  return next
}

/** Модель иногда оборачивает JSON в ```-блок несмотря на инструкцию. */
function parseSummary(raw: string, model: string): Summary {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  const candidate = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned

  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    // Если JSON не разобрался — сохраняем хотя бы текст, чтобы работа не пропала.
    return Summary.parse({ tldr: cleaned.slice(0, 2000), generatedAt: new Date().toISOString(), model })
  }
  const result = Summary.safeParse({ ...(parsed as object), generatedAt: new Date().toISOString(), model })
  return result.success
    ? result.data
    : Summary.parse({ tldr: cleaned.slice(0, 2000), generatedAt: new Date().toISOString(), model })
}

