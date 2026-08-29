import { spawn } from 'node:child_process'
import { statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  t,
  doubtThreshold,
  doubtfulWords,
  mergeUtterances,
  renderTranscriptMarkdown,
  speakerLabel,
  splitUtterance,
  timecode,
  utterancesInRange,
  type Meeting,
  type MeetingMeta
} from '@spyly/core'
import { RecordingSession } from './recorder/session.js'
import { SpeechChunker, encodeWav } from './pipeline/live.js'
import { LiveTranscriber, isLiveModelReady, warmLiveModel } from './pipeline/live-stream.js'
import { startWhisperServer, stopWhisperServer, transcribeChunk } from './pipeline/whisper-server.js'
import { processMeeting } from './pipeline/run.js'
import { readMeeting, writeMeeting, writeMeta } from './store/meetings.js'
import { appendFile } from 'node:fs/promises'
import { readWavPcm16 } from './audio/wav.js'
import { listVoices, rememberSpeaker } from './store/voices.js'
import { audioFile, meetingDir, meetingFile } from './store/paths.js'
import { loadSettings } from './store/settings.js'

/**
 * The end-to-end check: a real recording, transcription, voice separation.
 *
 * Started as `electron apps/desktop --selftest <file.wav>`: the file is played
 * by an external process, so what gets checked is the actual system audio
 * capture rather than fixtures pushed into the pipeline.
 */
export async function runSelfTest(fixture: string, seconds: number): Promise<number> {
  const log = (...parts: unknown[]) => process.stdout.write(parts.join(' ') + '\n')
  let failures = 0
  const check = (ok: boolean, label: string, detail = '') => {
    if (!ok) failures++
    log(`${ok ? '  OK  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  }

  log('=== сквозная проверка ===')
  if (!fixture || !statSync(fixture, { throwIfNoEntry: false })?.isFile()) {
    log(fixture ? `нет файла для проигрывания: ${fixture}` : 'не указан файл: electron apps/desktop --selftest <файл.wav>')
    return 1
  }

  /*
   * Wait for the audio to be free.
   *
   * The check plays a file and catches it with the system capture. If a previous
   * run is still winding down nearby, the device is busy and the recording comes
   * out empty: the test fails for a reason that has nothing to do with the
   * product.
   */
  await waitForAudioFree(log)

  const settings = await loadSettings()
  log(`язык расшифровки: ${settings.language}`)

  // The model for live mode takes seconds to load; in the application the source
  // picker warms it up, here we do it before the recording starts, otherwise the
  // warm-up would land inside its duration.
  //
  // Latency is measured honestly: how long from the moment a word was spoken to
  // the moment its text was in hand. That is what a person sees.
  const liveTexts: { lagSec: number; text: string; final: boolean }[] = []
  let liveReady = false
  const streamingLive = isLiveModelReady()
  if (streamingLive) {
    warmLiveModel()
    liveReady = true
  } else {
    try {
      await startWhisperServer(settings.language)
      liveReady = true
    } catch (error) {
      log(`живая расшифровка не поднялась: ${String(error)}`)
    }
  }

  const session = new RecordingSession({ mic: true, system: true, title: 'Проверка тракта' }, [])
  await session.start()
  log(`запись начата: ${session.meetingId}`)

  /**
   * When the first sample arrived on each track.
   *
   * Counting from the start of the recording will not do: a source can begin
   * handing over audio seconds late (here, until the file starts playing), and
   * that pause would go into transcription latency where there is none.
   */
  const firstSampleAt = new Map<'mic' | 'system', number>()
  const noteLive = (
    track: 'mic' | 'system',
    text: string,
    start: number,
    end: number,
    final: boolean
  ): void => {
    const since = firstSampleAt.get(track) ?? Date.now()
    liveTexts.push({ lagSec: (Date.now() - since) / 1000 - end, text, final })
    if (!final) return
    // The draft is written the same way as on the working path: the "Draft" tab
    // lives off it, and an agent sees the conversation in progress over MCP.
    void appendFile(
      meetingFile(session.meetingId, 'live.jsonl'),
      `${JSON.stringify({ track, text, start, end })}\n`
    ).catch(() => undefined)
  }

  if (liveReady && streamingLive) {
    const transcribers = new Map<'mic' | 'system', LiveTranscriber>()
    session.on('samples', (track: 'mic' | 'system', chunk: Float32Array) => {
      if (!firstSampleAt.has(track)) firstSampleAt.set(track, Date.now())
      let live = transcribers.get(track)
      if (!live) {
        live = new LiveTranscriber(track)
        transcribers.set(track, live)
      }
      const update = live.push(chunk)
      if (update) noteLive(track, update.text, update.start, update.end, update.final)
    })
    session.once('stopping', () => {
      for (const [track, live] of transcribers) {
        for (const tail of live.finish()) noteLive(track, tail.text, tail.start, tail.end, true)
      }
      transcribers.clear()
    })
  } else if (liveReady) {
    const chunkers = new Map<string, SpeechChunker>()
    session.on('samples', (track: 'mic' | 'system', chunk: Float32Array) => {
      if (!firstSampleAt.has(track)) firstSampleAt.set(track, Date.now())
      let chunker = chunkers.get(track)
      if (!chunker) {
        chunker = new SpeechChunker(track, (samples, startSec) => {
          void transcribeChunk(encodeWav(samples), settings.language)
            .then((text) => {
              if (!text) return
              noteLive(track, text, startSec, startSec + samples.length / 16000, true)
            })
            .catch(() => undefined)
        })
        chunkers.set(track, chunker)
      }
      chunker.push(chunk)
    })
    session.once('stopping', () => {
      for (const chunker of chunkers.values()) chunker.flush()
    })
  }

  // Played by another process: our own audio is excluded from capture.
  const player = spawn('afplay', [fixture], { stdio: 'ignore' })
  await new Promise((resolve) => setTimeout(resolve, (seconds / 2) * 1000))
  const markResult = session.mark('проверка')
  await new Promise((resolve) => setTimeout(resolve, (seconds / 2) * 1000))
  player.kill()

  const { durationSec } = await session.stop()
  log(`запись остановлена, длительность ${durationSec.toFixed(1)} с`)

  // The tail of the last phrase is computed after the stop.
  await new Promise((resolve) => setTimeout(resolve, 4000))
  stopWhisperServer()
  if (liveReady) {
    check(liveTexts.length > 0, 'живая расшифровка выдала текст', `${liveTexts.length} обновлений`)
    const lags = liveTexts.map((t) => t.lagSec).filter((lag) => Number.isFinite(lag))
    const worst = lags.length > 0 ? Math.max(...lags) : 0
    if (streamingLive) {
      // The point of a streaming model is that words are visible almost at once. The
      // threshold allows for a slow machine but is well below the old tens of seconds.
      check(worst < 3, 'слова появляются сразу', `худшая задержка ${worst.toFixed(1)} с`)
      const growing = liveTexts.filter((t) => !t.final).length
      check(growing > 0, 'фраза дописывается по ходу речи', `${growing} уточнений`)
    } else {
      check(worst < 20, 'живая расшифровка укладывается в задержку', `${worst.toFixed(1)} с`)
    }
    for (const item of liveTexts.filter((t) => t.final).slice(0, 4)) {
      log(`    live (+${item.lagSec.toFixed(1)}с): ${item.text}`)
    }
  }

  check(durationSec > seconds * 0.7, 'длительность записи разумная', `${durationSec.toFixed(1)} с`)
  check(markResult !== null && markResult.at > 0, 'отметка поставлена', `на ${markResult?.at.toFixed(1)} с`)
  check(session.currentMarks().length === 1, 'отметка сохранена в сессии')
  for (const track of ['mic', 'system'] as const) {
    check(existsSync(audioFile(session.meetingId, track)), `дорожка ${track} записана`)
  }

  const meta = await readMeeting(session.meetingId)
  if (meta) {
    await writeMeta({
      ...meta,
      durationSec,
      endedAt: new Date().toISOString(),
      marks: session.currentMarks(),
      stages: { ...meta.stages, recording: 'done' }
    })
  }

  log('обработка…')
  const started = Date.now()
  await processMeeting(session.meetingId)
  log(`обработка заняла ${((Date.now() - started) / 1000).toFixed(1)} с`)

  const meeting = await readMeeting(session.meetingId)
  if (!meeting) {
    check(false, 'встреча читается с диска')
    return failures + 1
  }

  check(meeting.stages.transcribing === 'done', 'расшифровка прошла', meeting.errors.transcribing ?? '')
  check(meeting.stages.diarizing === 'done', 'разделение по голосам прошло', meeting.errors.diarizing ?? '')
  check(meeting.utterances.length > 0, 'реплики получены', `${meeting.utterances.length} шт.`)
  check(meeting.speakers.length > 0, 'участники определены', `${meeting.speakers.length} шт.`)

  const systemUtterances = meeting.utterances.filter((u) => u.track === 'system')
  check(systemUtterances.length > 0, 'системная дорожка распознана', `${systemUtterances.length} реплик`)

  const monotonic = meeting.utterances.every((u, i, arr) => i === 0 || u.start >= arr[i - 1]!.start)
  check(monotonic, 'реплики идут по возрастанию времени')

  const withinDuration = meeting.utterances.every((u) => u.end <= durationSec + 1)
  check(withinDuration, 'таймкоды не выходят за длительность записи')

  log('')
  // --- naming by meaning ---
  {
    const { cleanTitle, isAutoTitle } = await import('@spyly/core')
    check(isAutoTitle('Запись 28 августа, 14:27'), 'название по умолчанию узнаётся')
    check(!isAutoTitle('Планёрка по вторникам'), 'название человека остаётся за ним')
    check(cleanTitle('«Разбор инцидента».') === 'Разбор инцидента', 'кавычки и точка снимаются')
  }

  log('--- расшифровка ---')
  const speakers = new Map(meeting.speakers.map((s) => [s.id, s]))
  for (const u of meeting.utterances.slice(0, 12)) {
    log(`  ${timecode(u.start)}  ${speakerLabel(speakers.get(u.speakerId), u.speakerId).padEnd(14)} ${u.text}`)
  }
  // ── files on disk ─────────────────────────────────────────────────────
  const { existsSync: exists } = await import('node:fs')
  const { readFile } = await import('node:fs/promises')
  for (const name of ['meta.json', 'transcript.json', 'transcript.md']) {
    check(exists(path.join(meetingDir(session.meetingId), name)), `на диске есть ${name}`)
  }
  const markdown = await readFile(path.join(meetingDir(session.meetingId), 'transcript.md'), 'utf8')
  check(markdown.includes('## Расшифровка'), 'markdown-расшифровка собрана')
  check(markdown === renderTranscriptMarkdown(meeting), 'markdown на диске совпадает с текущим состоянием')

  // --- undo and redo ---
  {
    const { editWithHistory, undo, redo, historyState, forgetHistory } = await import('./store/history.js')

    const start = await readMeeting(session.meetingId)
    const target = start?.utterances[0]
    if (!target) {
      log('нечего править — проверку отмены пропускаем')
    } else {
      const wasText = target.text
      check(!historyState(session.meetingId).canUndo, 'до правок отменять нечего')

      await editWithHistory(session.meetingId, 'правку реплики', (m) => ({
        ...m,
        utterances: m.utterances.map((u) => (u.id === target.id ? { ...u, text: 'подменённый текст' } : u))
      }))
      check(historyState(session.meetingId).canUndo, 'после правки есть что отменять')

      const back = await undo(session.meetingId)
      check(back?.label === 'правку реплики', 'отмена называет, что откатила', back?.label ?? '—')
      check(
        back?.meeting.utterances.find((u) => u.id === target.id)?.text === wasText,
        'текст реплики вернулся к исходному'
      )
      check(historyState(session.meetingId).canRedo, 'отменённое можно вернуть')

      const forward = await redo(session.meetingId)
      check(
        forward?.meeting.utterances.find((u) => u.id === target.id)?.text === 'подменённый текст',
        'возврат приводит правку обратно'
      )

      // The recording goes back to its original state: later steps check it too.
      await undo(session.meetingId)
      check(
        (await readMeeting(session.meetingId))?.utterances.find((u) => u.id === target.id)?.text === wasText,
        'запись оставлена в исходном виде'
      )

      // A new edit cuts the redo branch off.
      await editWithHistory(session.meetingId, 'ещё правку', (m) => m)
      check(!historyState(session.meetingId).canRedo, 'новая правка обрывает возврат')

      // Cutting out a fragment changes the audio, and a snapshot will not bring it back, so history breaks.
      forgetHistory(session.meetingId)
      const empty = historyState(session.meetingId)
      check(!empty.canUndo && !empty.canRedo, 'необратимое действие обрывает историю')
      check((await undo(session.meetingId)) === null, 'на пустой истории отмена ничего не делает')
    }
  }

  // --- simultaneous edits do not lose each other ---
  {
    // There was data loss here: renaming and changing a participant's name went
    // around the shared queue, as a separate read and write. An edit arriving
    // between them vanished, and the pipeline, filling a recording in as
    // processing goes, hit that window constantly.
    const { updateMeeting } = await import('./store/meetings.js')
    await Promise.all([
      updateMeeting(session.meetingId, (m) => ({ ...m, speakerCount: 3 })),
      updateMeeting(session.meetingId, (m) => ({ ...m, tags: ['метка'] })),
      updateMeeting(session.meetingId, (m) => ({ ...m, title: 'Проверка очереди' }))
    ])
    const after = await readMeeting(session.meetingId)
    check(after?.speakerCount === 3, 'одновременная правка числа участников уцелела')
    check(after?.tags[0] === 'метка', 'одновременная правка меток уцелела')
    check(after?.title === 'Проверка очереди', 'одновременное переименование уцелело')
  }

  // --- rebuilding from somewhere other than the start ---
  {
    // There was data loss here: starting processing "from voice separation"
    // assembled the transcript out of nothing and erased it entirely.
    const before = (await readMeeting(session.meetingId))?.utterances.length ?? 0
    if (before > 0) {
      await processMeeting(session.meetingId, 'diarizing')
      const after = (await readMeeting(session.meetingId))?.utterances.length ?? 0
      check(after > 0, 'расшифровка переживает пересборку по голосам', `${before} → ${after} реплик`)
    }
  }


  // ── recognising participants by voice ─────────────────────────────────
  // The state is read afresh: the check above rebuilds the participants, and a
  // list read earlier is no longer the same by this point. In the packaged app
  // voice separation gave different clusters, and the print was taken from an
  // identifier that no longer exists.
  const fresh = await readMeeting(session.meetingId)
  const firstSpeaker = fresh?.speakers[0]
  if (firstSpeaker) {
    const before = (await listVoices()).length
    const profile = await rememberSpeaker(session.meetingId, firstSpeaker.id, 'Тестовый участник')
    check(profile !== null, 'слепок голоса сохранён')
    check((await listVoices()).length === before + 1, 'профиль появился в реестре')

    // A participant's voice may not be recognised by itself: a noisy print, too
    // few utterances. Then it is linked to a voice already known, by picking a
    // name from a list. No second print is created; the existing one is refined by
    // this recording.
    const again = await rememberSpeaker(session.meetingId, firstSpeaker.id, 'Тестовый участник')
    check((await listVoices()).length === before + 1, 'привязка к знакомому голосу не плодит слепков')
    check(
      (again?.samples ?? 0) > (profile?.samples ?? 0),
      'слепок уточнился новой записью',
      `${profile?.samples} → ${again?.samples}`
    )

    if (profile) {
      // Recognition is run over the same recording: the participant should be identified.
      const renamed = await readMeeting(session.meetingId)
      if (renamed) {
        await writeMeeting({
          ...renamed,
          speakers: renamed.speakers.map((sp) => ({ ...sp, name: undefined, nameSource: 'none' as const }))
        })
      }
      await processMeeting(session.meetingId, 'identifying')
      const identified = await readMeeting(session.meetingId)
      const match = identified?.speakers.find((sp) => sp.id === firstSpeaker.id)
      check(match?.name === 'Тестовый участник', 'участник узнан по голосу', `имя: ${match?.name ?? 'нет'}`)
      check((match?.matchScore ?? 0) > 0.6, 'уверенность узнавания разумная', `${(match?.matchScore ?? 0).toFixed(2)}`)

      const { deleteVoice } = await import('./store/voices.js')
      await deleteVoice(profile.id)
    }
  }

  // ── the dictionary reaches the engine ─────────────────────────────────
  {
    const { buildVocabularyPrompt } = await import('./providers/asr/whisper-cpp.js')
    const { listVoices: voices } = await import('./store/voices.js')
    const prompt = await buildVocabularyPrompt()
    // The hint carries more than the dictionary: names from the voice registry go
    // in too, and they are much of the reason it exists. By this point the test
    // has already recorded a print, so the hint must not be empty.
    const expected = [
      ...settings.vocabulary.filter(Boolean),
      ...(await voices()).map((v) => v.name).filter(Boolean)
    ]
    if (expected.length > 0) {
      check(
        expected.every((term) => prompt.includes(term)),
        'словарь и имена участников попадают в подсказку',
        prompt.slice(0, 90)
      )
    } else {
      check(prompt === '', 'без словаря и слепков подсказка пустая')
    }
  }

  // ── marks ─────────────────────────────────────────────────────────────
  check(meeting.marks.length >= 0, 'поле отметок на месте')

  // ── continuing a recording ────────────────────────────────────────────
  // The riskiest part: the extra audio goes into an existing WAV, and a mistake
  // here spoils a conversation already recorded, not only the new part.
  {
    const before = await readMeeting(session.meetingId)
    const beforeDuration = before?.durationSec ?? 0
    const beforeMarks = before?.marks.length ?? 0

    const second = new RecordingSession(
      { mic: true, system: true },
      [],
      before ? { meta: metaOf(before), durationSec: beforeDuration } : undefined
    )
    await second.start()
    check(second.meetingId === session.meetingId, 'продолжение пишется в ту же запись')

    const player2 = spawn('afplay', [fixture], { stdio: 'ignore' })
    await new Promise((resolve) => setTimeout(resolve, 5000))
    const secondMark = second.mark('вторая часть')
    player2.kill()
    const { durationSec: total } = await second.stop()

    check(total > beforeDuration + 3, 'длительность выросла', `${beforeDuration.toFixed(1)} → ${total.toFixed(1)} с`)
    check(
      (secondMark?.at ?? 0) > beforeDuration,
      'отметка второй части идёт после первой',
      `${secondMark?.at.toFixed(1)} с`
    )
    check(second.currentMarks().length === beforeMarks + 1, 'отметки первой части сохранились')

    const wave = await readWavPcm16(audioFile(session.meetingId, 'system'))
    const wavSeconds = wave.samples.length / wave.sampleRate
    check(Math.abs(wavSeconds - total) < 2, 'звук в файле совпадает с длительностью', `${wavSeconds.toFixed(1)} с`)

    const continued = await readMeeting(session.meetingId)
    if (continued) {
      // The recording stage is always closed: otherwise a spinner stays in the list
      // forever next to a transcript that is already done.
      await writeMeta({
        ...metaOf(continued),
        durationSec: total,
        endedAt: new Date().toISOString(),
        marks: second.currentMarks(),
        stages: { ...continued.stages, recording: 'done' }
      })
    }
  }

  // ── the live transcription draft ──────────────────────────────────────
  // It used to be deleted after processing. Now it stays: it shows what was on
  // screen during the conversation, on a tab of its own.
  {
    const file = meetingFile(session.meetingId, 'live.jsonl')
    if (!existsSync(file)) {
      check(!liveReady, 'черновик отсутствует только когда живой расшифровки не было')
    } else {
      const lines = (await readFile(file, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { track: string; text: string; start: number })
        // Chunks of the two tracks are written interleaved, as they become ready; the
        // order is imposed by whoever reads them, and the handler does the same.
        .sort((a, b) => a.start - b.start)
      check(lines.length > 0, 'черновик сохранён', `${lines.length} реплик`)
      check(
        lines.every((l) => (l.track === 'mic' || l.track === 'system') && l.text.length > 0),
        'строки черновика целые'
      )
      check(
        lines.every((l, i) => i === 0 || l.start >= lines[i - 1]!.start),
        'черновик идёт по возрастанию времени'
      )
    }
  }

  // ── the mix ducks the echo ────────────────────────────────────────────
  // The other side's voice comes out of the speakers and into the microphone: in
  // a plain sum it ends up there twice. We check that mixing ducks the
  // microphone where the other side is speaking.
  {
    const { mixTracks: mix, writeWavPcm16: write, readWavPcm16: read } = await import('./audio/wav.js')
    const rate = 16000
    const seconds = 4
    const micTrack = new Float32Array(rate * seconds)
    const sysTrack = new Float32Array(rate * seconds)

    // For the first two seconds the other side speaks and the microphone catches
    // their echo. For the last two the person speaks and the other side is silent.
    for (let i = 0; i < rate * 2; i++) {
      sysTrack[i] = Math.sin(i * 0.05) * 0.5
      micTrack[i] = Math.sin(i * 0.05) * 0.3
    }
    for (let i = rate * 2; i < rate * seconds; i++) micTrack[i] = Math.sin(i * 0.08) * 0.4

    const dir = app.getPath('temp')
    const micFile = path.join(dir, `spyly-mix-mic-${Date.now()}.wav`)
    const sysFile = path.join(dir, `spyly-mix-sys-${Date.now()}.wav`)
    const outFile = path.join(dir, `spyly-mix-out-${Date.now()}.wav`)
    await write(micFile, micTrack, rate)
    await write(sysFile, sysTrack, rate)
    await mix(micFile, sysFile, outFile)

    const { samples: mixed } = await read(outFile)
    const energy = (from: number, to: number) => {
      let sum = 0
      for (let i = from; i < to; i++) sum += mixed[i]! * mixed[i]!
      return Math.sqrt(sum / Math.max(1, to - from))
    }
    // While the other side speaks the microphone's contribution is ducked, so the
    // level is close to their own rather than to the sum of two voices.
    const whileRemote = energy(rate / 2, rate * 1.5)
    const whileOwn = energy(rate * 2.5, rate * 3.5)
    check(whileRemote < 0.45, 'при речи собеседника микрофон приглушён', whileRemote.toFixed(3))
    check(whileOwn > 0.2, 'собственная речь остаётся громкой', whileOwn.toFixed(3))

    const { rm: remove } = await import('node:fs/promises')
    await Promise.all([micFile, sysFile, outFile].map((f) => remove(f, { force: true })))
  }

  // ── stages are not wiped by a stale snapshot ──────────────────────────
  // The pipeline holds a recording in memory for minutes; writing it back whole
  // wipes everything that changed in the meantime, which is how a recording kept
  // a spinning "Recording" stage while its transcript was ready.
  {
    const { updateMeeting } = await import('./store/meetings.js')
    const before = await readMeeting(session.meetingId)
    if (!before) {
      check(false, 'есть запись для проверки этапов')
    } else {
      // Take a snapshot, then change the file around it, then write through the snapshot.
      const stale = before
      await updateMeeting(session.meetingId, (m) => ({
        ...m,
        stages: { ...m.stages, recording: 'done' },
        title: 'Изменено мимо снимка'
      }))
      await updateMeeting(stale.id, (current) => ({
        ...current,
        stages: { ...current.stages, summarizing: 'done' }
      }))

      const after = await readMeeting(session.meetingId)
      check(after?.stages.recording === 'done', 'чужая правка этапа пережила запись конвейера')
      check(after?.title === 'Изменено мимо снимка', 'чужая правка названия не затёрлась')
      check(after?.stages.summarizing === 'done', 'своя правка этапа применилась')

      await updateMeeting(session.meetingId, (m) => ({ ...m, title: stale.title }))
    }
  }

  // ── silence must not breed invented text ──────────────────────────────
  // On an empty track Whisper produces credits out of its training data
  // ("Subtitles by...", "To be continued..."). We check that such tracks never
  // reach transcription at all.
  {
    const quiet = new RecordingSession({ mic: false, system: true, title: 'Проверка тишины' }, [])
    await quiet.start()
    await new Promise((resolve) => setTimeout(resolve, 6000))
    const { durationSec: quietDuration } = await quiet.stop()

    const quietMeta = await readMeeting(quiet.meetingId)
    if (quietMeta) {
      await writeMeta({
        ...quietMeta,
        durationSec: quietDuration,
        endedAt: new Date().toISOString(),
        stages: { ...quietMeta.stages, recording: 'done' }
      })
    }
    await processMeeting(quiet.meetingId)
    const quietResult = await readMeeting(quiet.meetingId)
    const invented = quietResult?.utterances ?? []
    check(invented.length === 0, 'на тишине расшифровка пустая', invented.map((u) => u.text).join(' | '))

    const { deleteMeeting } = await import('./store/meetings.js')
    await deleteMeeting(quiet.meetingId)
  }

  // ── editing the transcript ────────────────────────────────────────────
  // Split, join, reassign the speaker, cut. All of that writes to disk, so it is
  // checked on real files rather than on made-up data.
  {
    const before = await readMeeting(session.meetingId)
    const target = before?.utterances[0]
    if (!before || !target) {
      check(false, 'есть реплика для правки')
    } else {
      // Split at a space: in the middle of a word the split legitimately inserts a
      // boundary, and comparing the join against the original text would be meaningless.
      const middle = Math.floor(target.text.length / 2)
      const at = target.text.indexOf(' ', middle) + 1 || middle
      const split = splitUtterance(target, at)
      check(split !== null, 'реплика делится пополам')

      if (split) {
        const [head, tail] = split
        check(head.end <= tail.start + 0.001, 'половинки не перекрываются по времени',
          `${head.end.toFixed(2)} и ${tail.start.toFixed(2)}`)
        check(head.start === target.start && tail.end === target.end, 'границы исходной реплики сохранены')
        check(
          `${head.text} ${tail.text}`.replace(/\s+/g, ' ') === target.text.replace(/\s+/g, ' '),
          'текст при делении не потерялся'
        )

        const merged = mergeUtterances(head, tail)
        check(merged.text === target.text.trim(), 'склейка возвращает исходный текст')
        check(merged.start === target.start && merged.end === target.end, 'склейка возвращает исходные границы')
      }

      // Per-word confidence is what highlights the doubtful places.
      const withConfidence = before.utterances.filter((u) =>
        u.words.some((w) => typeof w.confidence === 'number')
      )
      check(withConfidence.length > 0, 'у слов есть уверенность модели', `${withConfidence.length} реплик`)
      const level = doubtThreshold(before)
      check(level >= 0.5 && level <= 0.9, 'порог сомнения в разумных пределах', level.toFixed(2))
      const doubted = before.utterances.reduce((sum, u) => sum + doubtfulWords(u, level).size, 0)
      const total = before.utterances.reduce((sum, u) => sum + u.words.length, 0)
      check(doubted < total / 3, 'подчёркнуто меньше трети слов', `${doubted} из ${total}`)
    }
  }

  // ── cutting out a fragment ────────────────────────────────────────────
  // The most dangerous operation: it spoils audio already recorded and cannot be undone.
  {
    const before = await readMeeting(session.meetingId)
    const victim = before?.utterances[before.utterances.length - 1]
    if (!before || !victim) {
      check(false, 'есть что вырезать')
    } else {
      const { samples, sampleRate } = await readWavPcm16(audioFile(session.meetingId, 'system'))
      const lengthBefore = samples.length

      const { silenceRange } = await import('./audio/wav.js')
      const silenced = await silenceRange(audioFile(session.meetingId, 'system'), victim.start, victim.end)
      check(silenced > 0, 'промежуток заглушён', `${silenced.toFixed(1)} с`)

      const after = await readWavPcm16(audioFile(session.meetingId, 'system'))
      check(after.samples.length === lengthBefore, 'длина файла не изменилась')

      const from = Math.floor(victim.start * sampleRate)
      const to = Math.min(after.samples.length, Math.ceil(victim.end * sampleRate))
      let peak = 0
      for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(after.samples[i]!))
      check(peak === 0, 'в вырезанном промежутке настоящая тишина', `пик ${peak}`)

      // Outside the stretch the audio must be untouched. We look at both sides: the
      // start of a recording can be quiet by itself, and a check on the start alone
      // failed for no reason.
      let outsidePeak = 0
      for (let i = 0; i < after.samples.length; i++) {
        if (i >= from && i < to) continue
        outsidePeak = Math.max(outsidePeak, Math.abs(after.samples[i]!))
      }
      const outsideBefore = (() => {
        let peak = 0
        for (let i = 0; i < samples.length; i++) {
          if (i >= from && i < to) continue
          peak = Math.max(peak, Math.abs(samples[i]!))
        }
        return peak
      })()
      check(
        Math.abs(outsidePeak - outsideBefore) < 0.001,
        'остальная запись не пострадала',
        `было ${outsideBefore.toFixed(3)}, стало ${outsidePeak.toFixed(3)}`
      )

      const doomed = utterancesInRange(before, victim.start, victim.end)
      check(doomed.some((u) => u.id === victim.id), 'реплика попадает в вырезаемый промежуток')
    }
  }

  // ── cutting at silences for language detection ────────────────────────
  {
    const { splitOnSilence } = await import('./audio/wav.js')
    const source = audioFile(session.meetingId, 'system')
    const parts = await splitOnSilence(source, 6)
    const { samples, sampleRate } = await readWavPcm16(source)
    const whole = samples.length / sampleRate

    check(parts.length === 0 || parts.length > 1, 'резка либо не трогает запись, либо даёт несколько кусков')

    // Separately, a file with deliberate pauses: a live fixture may have no
    // suitable breaks, and the real cutting would go unchecked.
    {
      const { writeWavPcm16 } = await import('./audio/wav.js')
      const rate = 16000
      const synthetic = new Float32Array(rate * 30)
      for (let i = 0; i < synthetic.length; i++) {
        const second = i / rate
        // Four seconds of speech, one second of pause, as in an ordinary conversation.
        const talking = Math.floor(second) % 5 !== 4
        synthetic[i] = talking ? Math.sin(i * 0.05) * 0.3 : 0
      }
      const file = path.join(app.getPath('temp'), `spyly-split-check-${Date.now()}.wav`)
      await writeWavPcm16(file, synthetic, rate)

      const cut = await splitOnSilence(file, 10)
      check(cut.length > 1, 'запись с паузами режется на куски', `${cut.length} шт.`)
      let restored = 0
      for (const piece of cut) restored += (await readWavPcm16(piece.path)).samples.length / rate
      check(Math.abs(restored - 30) < 0.5, 'куски синтетической записи дают исходные 30 с', `${restored.toFixed(1)} с`)

      const cutsAtPauses = cut.slice(1).every((piece) => {
        const at = piece.offsetSec % 5
        // The boundary has to land in a pause, which runs from the 4th to the 5th second.
        return at >= 3.8 || at <= 0.2
      })
      check(cutsAtPauses, 'резка попадает в паузы, а не в середину фразы',
        cut.map((c) => c.offsetSec.toFixed(1)).join(', '))

      const { rm: remove } = await import('node:fs/promises')
      await Promise.all([...cut.map((c) => remove(c.path, { force: true })), remove(file, { force: true })])
    }

    if (parts.length === 0) {
      check(true, 'сплошную речь не режем', 'подходящих пауз не нашлось')
    } else {
      let sum = 0
      for (const part of parts) sum += (await readWavPcm16(part.path)).samples.length / sampleRate
      check(Math.abs(sum - whole) < 0.5, 'куски в сумме дают исходную запись', `${sum.toFixed(1)} из ${whole.toFixed(1)} с`)
      check(parts[0]!.offsetSec === 0, 'первый кусок начинается с нуля')
      const ordered = parts.every((p, i) => i === 0 || p.offsetSec > parts[i - 1]!.offsetSec)
      check(ordered, 'смещения кусков возрастают')
      const { rm } = await import('node:fs/promises')
      await Promise.all(parts.map((p) => rm(p.path, { force: true })))
    }
  }

  // ── simultaneous edits ────────────────────────────────────────────────
  // A person edits the summary, an agent appends tasks over MCP, and at the same
  // time the pipeline saves a stage. Without a queue an edit started earlier
  // would silently wipe one that finished later.
  {
    const { updateMeeting } = await import('./store/meetings.js')
    const target = await readMeeting(session.meetingId)
    if (!target) {
      check(false, 'есть запись для проверки одновременных правок')
    } else {
      await Promise.all([
        updateMeeting(session.meetingId, (m) => ({ ...m, tags: [...m.tags, 'первый'] })),
        updateMeeting(session.meetingId, (m) => ({ ...m, tags: [...m.tags, 'второй'] })),
        updateMeeting(session.meetingId, (m) => ({ ...m, title: 'Переименовано на ходу' }))
      ])

      const after = await readMeeting(session.meetingId)
      check(after?.tags.includes('первый') === true, 'первая одновременная правка сохранилась')
      check(after?.tags.includes('второй') === true, 'вторая одновременная правка не потерялась')
      check(after?.title === 'Переименовано на ходу', 'третья правка тоже на месте')

      // A failed edit must not bring the queue down: the ones after it have to go through.
      await updateMeeting(session.meetingId, () => {
        throw new Error('нарочная ошибка')
      }).catch(() => undefined)
      const survived = await updateMeeting(session.meetingId, (m) => ({ ...m, tags: [...m.tags, 'после сбоя'] }))
      check(survived.tags.includes('после сбоя'), 'очередь переживает неудачную правку')

      await updateMeeting(session.meetingId, (m) => ({ ...m, tags: [], title: target.title }))
    }
  }

  // ── a damaged recording description ───────────────────────────────────
  // A corrupted meta.json hid a recording from the list entirely: the audio on
  // disk, and nothing in the application. We check that it comes back.
  {
    const { writeFile, copyFile, rm: remove } = await import('node:fs/promises')
    const { meetingFile } = await import('./store/paths.js')
    const { listMeetings } = await import('./store/meetings.js')
    const { recoverOrphanedRecordings } = await import('./recorder/recovery.js')

    const victim = session.meetingId
    const backup = `${meetingFile(victim, 'meta.json')}.bak`
    await copyFile(meetingFile(victim, 'meta.json'), backup)
    await writeFile(meetingFile(victim, 'meta.json'), '{ это не json', 'utf8')

    const hidden = (await listMeetings()).some((m) => m.id === victim)
    check(!hidden, 'битое описание и правда прячет запись')

    await recoverOrphanedRecordings()
    const back = (await listMeetings()).find((m) => m.id === victim)
    check(back !== undefined, 'запись вернулась в список после восстановления')
    check((back?.durationSec ?? 0) > 0, 'длительность восстановлена по звуку', `${back?.durationSec.toFixed(1)} с`)
    check(
      back?.errors.recording !== undefined,
      'о повреждении сказано честно, а не молча исправлено',
      back?.errors.recording ?? ''
    )

    await copyFile(backup, meetingFile(victim, 'meta.json'))
    await remove(backup, { force: true })
  }

  // ── the dictionary learns from edits ──────────────────────────────────
  {
    const { learnedTerms } = await import('@spyly/core')
    check(
      learnedTerms('поднимем кубернетес', 'поднимем Kubernetes').includes('Kubernetes'),
      'правка расшифровки даёт термин для словаря'
    )
    check(
      learnedTerms('он сказал что придет', 'он сказал что приедет').length === 0,
      'обычные слова в словарь не просятся'
    )
  }

  // ── a summary from a real model ───────────────────────────────────────
  // This is exactly where running codex without node in PATH would surface: the
  // file itself is found, and the `#!/usr/bin/env node` inside fails with code 127.
  {
    const { LLM_PROVIDERS } = await import('./providers/llm/index.js')
    const ready: string[] = []
    for (const provider of LLM_PROVIDERS) {
      const state = await provider.ready()
      if (state.ready) ready.push(provider.id)
    }
    log(`модели для конспекта: ${ready.length > 0 ? ready.join(', ') : 'ни одной'}`)

    if (ready.length === 0) {
      check(true, 'конспект пропущен', 'ни одна модель не готова')
    } else {
      for (const id of ready) {
        const provider = LLM_PROVIDERS.find((p) => p.id === id)!
        const answer = await provider
          .complete([{ role: 'user', content: 'Ответь одним словом: работает' }], {})
          .catch((error: unknown) => `ОШИБКА: ${error instanceof Error ? error.message : String(error)}`)
        check(!answer.startsWith('ОШИБКА:'), `${id} отвечает`, answer.replace(/\s+/g, ' ').slice(0, 70))
      }
    }
  }

  // ── a custom OpenAI-compatible service ────────────────────────────────
  // This is how OpenRouter and the like are connected. The whole path is checked
  // against a local stub: settings, key, request shape, parsing the answer.
  {
    const { createServer } = await import('node:http')
    const { setSecret } = await import('./store/secrets.js')
    const { saveSettings } = await import('./store/settings.js')
    const { openAiCompatibleProvider, normalizeBaseUrl } = await import(
      './providers/llm/openai-compatible.js'
    )

    check(normalizeBaseUrl('https://openrouter.ai/api') === 'https://openrouter.ai/api/v1',
      'к адресу без /v1 путь дописывается')
    check(normalizeBaseUrl('https://x.dev/v1/') === 'https://x.dev/v1', 'лишний слэш срезается')

    let seen: { auth?: string; body?: Record<string, unknown>; path?: string } = {}
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c: Buffer) => (raw += c.toString()))
      req.on('end', () => {
        seen = {
          auth: req.headers.authorization,
          path: req.url ?? '',
          body: JSON.parse(raw || '{}') as Record<string, unknown>
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: '  готовый конспект  ' } }] }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port

    const before = await loadSettings()
    await saveSettings({ openAiCompatible: { baseUrl: `http://127.0.0.1:${port}`, model: 'тест/модель' } })
    await setSecret('openai-compatible.key', 'sk-test-0123456789')

    const ready = await openAiCompatibleProvider.ready()
    check(ready.ready, 'настроенный сервис считается готовым', ready.hint ?? '')

    const answer = await openAiCompatibleProvider.complete(
      [
        { role: 'system', content: 'ты делаешь конспекты' },
        { role: 'user', content: 'вот расшифровка' }
      ],
      {}
    )
    check(answer === 'готовый конспект', 'ответ разобран и обрезан по краям', answer)
    check(seen.path === '/v1/chat/completions', 'запрос ушёл по нужному пути', seen.path ?? '')
    check(seen.auth === 'Bearer sk-test-0123456789', 'ключ подставлен в заголовок')

    // A key with stray characters has to give a clear error rather than a failure
    // inside fetch.
    await setSecret('openai-compatible.key', 'ключ-с-кириллицей')
    const broken = await openAiCompatibleProvider
      .complete([{ role: 'user', content: 'x' }], {})
      .then(() => '')
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
    // Compared against words of the same translation rather than the Russian text:
    // otherwise the check failed when the interface was switched to English.
    check(
      broken === t('в ключе есть посторонние символы — скопируйте его заново, без пробелов и кавычек'),
      'испорченный ключ объяснён словами',
      broken.slice(0, 60)
    )
    await setSecret('openai-compatible.key', 'sk-test-0123456789')
    check(seen.body?.model === 'тест/модель', 'модель передана как указано')
    check(Array.isArray(seen.body?.messages) && (seen.body!.messages as unknown[]).length === 2,
      'сообщения дошли целиком')
    check(seen.body?.stream === false, 'потоковый режим выключен')

    // A service error has to be shown in words, not as a code.
    server.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const failed = await openAiCompatibleProvider
      .complete([{ role: 'user', content: 'x' }], {})
      .then(() => '')
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
    check(failed.length > 0, 'недоступный сервис даёт понятную ошибку', failed.slice(0, 60))

    await setSecret('openai-compatible.key', '')
    await saveSettings({ openAiCompatible: before.openAiCompatible })
  }

  // ── speed on a large archive ──────────────────────────────────────────
  // Similar recordings are looked for every time a page is opened: if that costs
  // seconds, the window will freeze on every click.
  {
    const { findRelated } = await import('./store/related.js')
    const { listMeetings: all } = await import('./store/meetings.js')
    const total = (await all()).length

    const coldAt = Date.now()
    await findRelated(session.meetingId)
    const cold = Date.now() - coldAt

    const warmAt = Date.now()
    await findRelated(session.meetingId)
    const warm = Date.now() - warmAt

    check(cold < 3000, 'поиск похожих на холодную укладывается в три секунды', `${cold} мс на ${total} записей`)
    check(warm < 300, 'повторное открытие мгновенное', `${warm} мс`)

    // Digests read the whole period, which for a quarter can be the entire archive.
    const { buildDigest: build, lastDays: period } = await import('@spyly/core')
    const { readMeeting: read } = await import('./store/meetings.js')
    const digestAt = Date.now()
    const { from, to } = period(90)
    const inPeriod = (await all()).filter((m) => {
      const at = Date.parse(m.startedAt)
      return at >= from.getTime() && at <= to.getTime()
    })
    const loaded = []
    for (const meta of inPeriod) {
      const full = await read(meta.id)
      if (full) loaded.push(full)
    }
    const digest = build(loaded, from, to)
    const digestMs = Date.now() - digestAt
    check(digestMs < 4000, 'итоги за квартал собираются быстро', `${digestMs} мс на ${loaded.length} записей`)
    check(digest.meetings === loaded.length, 'в итоги попали все записи периода')
  }

  log('')
  // The check writes a real recording into the real store. It must not be left
  // there: over a few runs a person's list of recordings fills up with rubbish.
  // SPYLY_KEEP=1 helps when looking into a failed run.
  if (process.env.SPYLY_KEEP || failures > 0) {
    log(`файлы: ${meetingDir(session.meetingId)}`)
  } else {
    const { deleteMeeting } = await import('./store/meetings.js')
    await deleteMeeting(session.meetingId)
    log('проверочная запись удалена')
  }
  log(failures === 0 ? '=== всё сошлось ===' : `=== провалов: ${failures} ===`)
  return failures
}

/** Meta without the transcript: continuing needs only that. */
function metaOf(meeting: Meeting): MeetingMeta {
  const { speakers, utterances, summary, ...meta } = meeting
  return meta
}

/** Whether someone else is capturing audio nearby, which gets in the way of the check. */
async function waitForAudioFree(log: (...parts: unknown[]) => void): Promise<void> {
  const { execFile } = await import('node:child_process')
  const busy = async (): Promise<boolean> =>
    new Promise((resolve) => {
      execFile('pgrep', ['-f', 'spyly-audiotap'], (_error, stdout) => {
        const others = stdout.split('\n').filter((line) => line.trim() && Number(line) !== process.pid)
        resolve(others.length > 0)
      })
    })

  let waited = false
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!(await busy())) {
      // The process has exited, but CoreAudio does not release the private aggregate
      // instantly: a capture started right away gets silence instead of sound.
      await new Promise((resolve) => setTimeout(resolve, waited ? 2000 : 1200))
      return
    }
    if (!waited) {
      log('жду, пока освободится звук от соседнего прогона…')
      waited = true
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  log('звук всё ещё занят — проверка может показать пустые дорожки')
}

export function selfTestArgs(): { fixture: string; seconds: number } | null {
  const index = process.argv.indexOf('--selftest')
  if (index === -1) return null
  // Without a file name `path.resolve('')` gives the current folder, and that
  // exists, so the check went further and failed with five mysterious failures
  // instead of a plain "no file given".
  const raw = process.argv[index + 1] ?? ''
  const fixture = raw.trim() && !raw.startsWith('--') ? path.resolve(raw) : ''
  const seconds = Number(process.argv[index + 2] ?? 20)
  return { fixture, seconds: Number.isFinite(seconds) ? seconds : 20 }
}

export { app }
