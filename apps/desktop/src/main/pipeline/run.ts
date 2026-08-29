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
 * Full processing of a recording: transcription, voice separation, recognising
 * the participants, summary.
 *
 * The stages are independent and recorded in meta.json, so a failed
 * transcription can be restarted without touching anything else, and certainly
 * without recording the call again.
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

  // Processing rewrites the transcript from scratch, and earlier edits no longer
  // apply to it: undo would bring back utterances the new transcript does not have.
  forgetHistory(meetingId)

  const settings = await loadSettings()
  const order: Stage[] = ['transcribing', 'diarizing', 'identifying', 'summarizing']
  const startAt = Math.max(0, order.indexOf(from))

  // An earlier error has nothing to do with a new run: leaving it on screen means
  // showing a red "interrupted" next to work that is under way.
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

  // When not starting from transcription, the words come from the one already
  // there: without this, rebuilding "from voice separation" assembled the
  // transcript out of nothing and erased it, on exactly the button offered by
  // the question "how many people were speaking".
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
        // We record what it was transcribed with: a month later a transcript gives no
        // clue whether it was done with the light model or the most accurate one.
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
        // A summary is optional. If no model is configured, that is not a transcription
        // failure but simply a step not taken: no reason to alarm anyone in red.
        const provider = settings.autoSummarize ? getLlmProvider(settings.llmProvider) : null
        const status = provider ? await provider.ready().catch(() => ({ ready: false })) : { ready: false }
        if (status.ready) {
          meeting = await summarize(meetingId, settings.llmProvider)
          meeting = await save(meeting, {
            providers: { ...meeting.providers, llm: provider?.name ?? settings.llmProvider }
          })
        } else {
          // No summary was asked for, but naming the recording by its meaning is still
          // worth it: that is one short request, and a list of a dozen "Recording, 28
          // August" makes the conversation you want impossible to find.
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
      // No point going further: a summary without a transcript is meaningless.
      return
    }
  }

  meeting = await save(meeting, { stages: { done: 'done' } })
  send('meetings:changed', { id: meetingId })
  notifyReady(meeting)
}


/**
 * Report that a recording is ready.
 *
 * Processing takes minutes, and by then a person is usually busy with
 * something else: without a notification they learn the transcript is ready
 * only when they remember to look.
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
 * Save a change to a stage.
 *
 * Always through `updateMeeting` rather than by writing a snapshot: the
 * pipeline holds a recording in memory for minutes, and in that time it gets
 * changed. Stopping the recording marks the first stage done, a person edits
 * the transcript, an agent appends a task. Writing a snapshot wiped all of
 * that silently: on one recording "Recording" went on spinning even though
 * everything was already done.
 */
async function save(meeting: Meeting, patch: Partial<Meeting>): Promise<Meeting> {
  return updateMeeting(meeting.id, (current) => ({
    ...current,
    ...patch,
    // Stages and errors are merged rather than replaced: the patch carries only
    // the stage that was changing just then.
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
  // The engine follows from the chosen model: a person chooses quality, not an
  // engine, since comparing engines by eye is not possible anyway.
  const provider = providerForModel(modelId)
  const status = await provider.ready()
  if (!status.ready) throw new Error(`расшифровка недоступна: ${status.hint ?? t('провайдер не готов')}`)

  const out: AsrResult[] = []
  for (const [index, track] of tracks.entries()) {
    const file = audioFile(meetingId, track)

    // An empty track is never handed to recognition: on silence Whisper produces
    // subtitle credits out of its training data instead of admitting there is no speech.
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

/** The average energy of a stretch of recording, which shows whether there really was speech. */
/**
 * The loudest spot inside a stretch.
 *
 * The average level over a whole utterance will not do: an utterance is glued
 * together out of several phrases with pauses between them, and those dilute
 * the speech to nothing. On a real recording "hello everyone, how are you, I'm
 * fine", three phrases over ten seconds, gave an average of 0.0058 against a
 * threshold of 0.006, and live speech was thrown away as silence. The question
 * is not "is it loud on average" but "was there any speech here at all".
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
 * The tracks are diarized independently.
 *
 * Cluster 0 of the microphone and cluster 0 of the system audio are different
 * people and must not be mixed. On the other hand one person cannot be on both
 * tracks at once, so matching clusters across tracks is not needed either.
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
    // The number of participants, when it has been given, is set firmly. It is
    // split in half between the tracks with room to spare: the microphone carries
    // whoever is in the room, the system audio the remote people, and nobody knows
    // the exact split in advance.
    const perTrack = speakerCount
      ? Math.max(1, Math.min(speakerCount, tracks.length > 1 ? Math.ceil(speakerCount / 2) + 1 : speakerCount))
      : undefined
    const turns = await provider.diarize(audioFile(meetingId, track), { numSpeakers: perTrack })
    out.set(track, turns)
  }
  return out
}

/**
 * A report of what did not make it into the transcript, and why.
 *
 * There are several filters along the way, and when an utterance disappears no
 * amount of reading the code says which one fired. Switched on with
 * `SPYLY_DIAG_FILTERS=1`.
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
 * Replace the text of an utterance, keeping the words consistent with it.
 *
 * Words carry times, and speech is later laid out by speaker using them. Left
 * as they were, the utterance would keep words the text no longer has. We walk
 * the words in order and take those found in the new text past the previous
 * one; the discarded ones simply are not found.
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

    // Filtering out invented text, by the text and by the audio under the
    // utterance. The text alone is not enough, as the model sometimes makes up a
    // plausible phrase; energy alone is not either, because credits also turn up
    // on top of quiet speech.
    const wave = await readWavPcm16(audioFile(meetingId, asr.track)).catch(() => null)
    const cleaned = utterances
      .map((u) => {
        if (!isLikelyHallucination(u.text)) return u
        // Subtitle credits stick to the edge of an utterance and used to drag all the
        // live speech away with them: on a real recording "Subtitles by DimaTorzok"
        // carried off thirty-seven seconds of conversation. We cut out the credits,
        // not the utterance.
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
   * Without headphones the microphone hears the other side through the speakers.
   *
   * Comparing the texts is unreliable here: recognition of the two tracks
   * diverges, and on a real recording only three echoes out of five were
   * recognised by text. So the level comes first: the path speakers to
   * microphone weakens the sound several times over, and that is unmistakable.
   */
  {
    const micWave = await readWavPcm16(audioFile(meetingId, 'mic')).catch(() => null)
    const systemWave = await readWavPcm16(audioFile(meetingId, 'system')).catch(() => null)
    const micUtterances = byTrack.get('mic') ?? []

    if (micWave && systemWave && micUtterances.length > 0) {
      const micLevels = levelWindows(micWave.samples, micWave.sampleRate)
      const systemLevels = levelWindows(systemWave.samples, systemWave.sampleRate)

      if (micIsOnlyEcho(micLevels, systemLevels)) {
        // The person was silent for the whole recording: the microphone track is echo
        // throughout, and everything coming out of it would be attributed to them by mistake.
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
          // The other side's last word often sticks to the beginning of your utterance:
          // the two tracks are cut into pieces differently.
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

  // What is left is filtered further by text: echo can be loud too, when the
  // speakers are turned up.
  const systemUtterances = byTrack.get('system') ?? []
  const beforeEcho = byTrack.get('mic') ?? []
  const micUtterances = suppressEcho(beforeEcho, systemUtterances)
  for (const u of beforeEcho) {
    if (!micUtterances.includes(u)) dropped(u, 'эхо по тексту')
  }
  const utterances = mergeTracks(micUtterances, systemUtterances)

  // Participants come from the utterances rather than from the diarization
  // segments: once echo is removed some microphone clusters disappear, and they
  // must not stay in the participant list as empty lines.
  const speakers: Speaker[] = []
  // A speaker may be left without diarization segments, if the whole track went
  // to one speaker for instance; then they appear only in the utterances.
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

  // The utterances are already in time order, so numbering follows first
  // appearance: that way "Speaker 2" really is the second one in the conversation.
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

/** Fill in the names of regular participants from their voice prints. */
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
    // The voice print is taken from a participant's utterances rather than from
    // the separation segments. Once echo is removed these are no longer the same
    // thing: some segments were left without utterances, and a print over them was
    // either not computed at all or computed over somebody else's speech. On a
    // real recording this left the second microphone cluster without a print and
    // nameless, even though by its utterances it matched at 0.502.
    const turns = meeting.utterances
      .filter((u) => u.track === track)
      .map((u) => ({ start: u.start, end: u.end, cluster: Number(u.speakerId.split(':')[1] ?? 0) }))

    for (const speaker of meeting.speakers.filter((s) => s.track === track)) {
      const embedding = embedSpeaker(wave.samples, wave.sampleRate, turns, speaker.cluster)
      // The microphone track is whoever sits at the computer: the recognition
      // threshold for your own print is gentler there.
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
 * Merge clusters recognised as the same person.
 *
 * Voice separation can break one person's speech into several clusters. While
 * they are nameless this shows only as extra "Speaker 4" and "In the room 6";
 * but if both matched the same voice print there is no reason to keep them
 * apart, as the person appeared twice in the participant list and their share
 * of the conversation was halved.
 */
function mergeSameSpeaker(meeting: Meeting): Meeting {
  const keep = new Map<string, string>()
  const remap = new Map<string, string>()

  for (const speaker of meeting.speakers) {
    if (!speaker.name || speaker.nameSource !== 'voice-match') continue
    // The same person cannot be on two tracks at once, so merging happens only
    // within one track.
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
 * Name a recording after what the conversation was about.
 *
 * A name given by a person is never touched, only one the application invented
 * itself: "Recording, 28 August, 14:27" says nothing about the conversation,
 * and in a list of a dozen like it the one you want cannot be found.
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

/** The model sometimes wraps JSON in a ``` block despite the instruction. */
function parseSummary(raw: string, model: string): Summary {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  const candidate = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned

  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    // If the JSON did not parse, keep at least the text, so the work is not lost.
    return Summary.parse({ tldr: cleaned.slice(0, 2000), generatedAt: new Date().toISOString(), model })
  }
  const result = Summary.safeParse({ ...(parsed as object), generatedAt: new Date().toISOString(), model })
  return result.success
    ? result.data
    : Summary.parse({ tldr: cleaned.slice(0, 2000), generatedAt: new Date().toISOString(), model })
}

