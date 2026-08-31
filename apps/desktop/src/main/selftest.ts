import { spawn } from 'node:child_process'
import { statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  t,
  renderTranscriptMarkdown,
  speakerLabel,
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
import { readMeeting, writeMeta } from './store/meetings.js'
import { appendFile } from 'node:fs/promises'
import { readWavPcm16 } from './audio/wav.js'
import { audioFile, meetingDir, meetingFile } from './store/paths.js'
import { loadSettings } from './store/settings.js'

/**
 * The end-to-end check: a real recording, transcription, summary.
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

  log('=== end-to-end check ===')
  if (!fixture || !statSync(fixture, { throwIfNoEntry: false })?.isFile()) {
    log(fixture ? `no file to play: ${fixture}` : 'no file given: electron apps/desktop --selftest <file.wav>')
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
  log(`transcription language: ${settings.language}`)

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
      log(`live transcription did not come up: ${String(error)}`)
    }
  }

  const session = new RecordingSession({ mic: true, system: true, title: 'Pipeline check' }, [])
  await session.start()
  log(`recording started: ${session.meetingId}`)

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
  const markResult = session.mark('check')
  await new Promise((resolve) => setTimeout(resolve, (seconds / 2) * 1000))
  player.kill()

  const { durationSec } = await session.stop()
  log(`recording stopped, duration ${durationSec.toFixed(1)} s`)

  // The tail of the last phrase is computed after the stop.
  await new Promise((resolve) => setTimeout(resolve, 4000))
  stopWhisperServer()
  if (liveReady) {
    check(liveTexts.length > 0, 'live transcription produced text', `${liveTexts.length} updates`)
    const lags = liveTexts.map((t) => t.lagSec).filter((lag) => Number.isFinite(lag))
    const worst = lags.length > 0 ? Math.max(...lags) : 0
    if (streamingLive) {
      // The point of a streaming model is that words are visible almost at once. The
      // threshold allows for a slow machine but is well below the old tens of seconds.
      check(worst < 3, 'words appear straight away', `worst latency ${worst.toFixed(1)} s`)
      const growing = liveTexts.filter((t) => !t.final).length
      check(growing > 0, 'a phrase is extended as speech goes on', `${growing} refinements`)
    } else {
      check(worst < 20, 'live transcription keeps within its latency', `${worst.toFixed(1)} s`)
    }
    for (const item of liveTexts.filter((t) => t.final).slice(0, 4)) {
      log(`    live (+${item.lagSec.toFixed(1)}s): ${item.text}`)
    }
  }

  check(durationSec > seconds * 0.7, 'the recording duration is sensible', `${durationSec.toFixed(1)} s`)
  check(markResult !== null && markResult.at > 0, 'a mark was placed', `at ${markResult?.at.toFixed(1)} s`)
  check(session.currentMarks().length === 1, 'the mark was kept in the session')
  for (const track of ['mic', 'system'] as const) {
    check(existsSync(audioFile(session.meetingId, track)), `track ${track} was written`)
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

  log('processing…')
  const started = Date.now()
  await processMeeting(session.meetingId)
  log(`processing took ${((Date.now() - started) / 1000).toFixed(1)} s`)

  const meeting = await readMeeting(session.meetingId)
  if (!meeting) {
    check(false, 'the meeting reads back from disk')
    return failures + 1
  }

  check(meeting.stages.transcribing === 'done', 'transcription went through', meeting.errors.transcribing ?? '')
  check(meeting.utterances.length > 0, 'utterances were produced', `${meeting.utterances.length} of them`)
  check(meeting.speakers.length > 0, 'the sides of the conversation were worked out', `${meeting.speakers.length} of them`)

  const systemUtterances = meeting.utterances.filter((u) => u.track === 'system')
  check(systemUtterances.length > 0, 'the system track was recognised', `${systemUtterances.length} utterances`)

  const monotonic = meeting.utterances.every((u, i, arr) => i === 0 || u.start >= arr[i - 1]!.start)
  check(monotonic, 'the utterances run in increasing time')

  const withinDuration = meeting.utterances.every((u) => u.end <= durationSec + 1)
  check(withinDuration, 'the timestamps stay inside the recording duration')

  log('')
  // --- naming by meaning ---
  {
    const { cleanTitle, isAutoTitle } = await import('@spyly/core')
    // The Russian wording stays: this is the default title the application
    // produces, and the check is about recognising it.
    check(isAutoTitle('Запись 28 августа, 14:27'), 'a default title is recognised')
    check(!isAutoTitle('Tuesday standup'), 'a title given by a person stays theirs')
    check(cleanTitle('«Разбор инцидента».') === 'Разбор инцидента', 'quotation marks and a full stop are stripped')
  }

  log('--- the transcript ---')
  const speakers = new Map(meeting.speakers.map((s) => [s.id, s]))
  for (const u of meeting.utterances.slice(0, 12)) {
    log(`  ${timecode(u.start)}  ${speakerLabel(speakers.get(u.speakerId), u.speakerId).padEnd(14)} ${u.text}`)
  }
  // ── files on disk ─────────────────────────────────────────────────────
  const { existsSync: exists } = await import('node:fs')
  const { readFile } = await import('node:fs/promises')
  for (const name of ['meta.json', 'transcript.json', 'transcript.md']) {
    check(exists(path.join(meetingDir(session.meetingId), name)), `on disk there are ${name}`)
  }
  const markdown = await readFile(path.join(meetingDir(session.meetingId), 'transcript.md'), 'utf8')
  check(markdown.includes(`## ${t('Расшифровка')}`), 'the markdown transcript was assembled')
  check(markdown === renderTranscriptMarkdown(meeting), 'the markdown on disk matches the current state')

  // --- undo and redo ---
  {
    const { editWithHistory, undo, redo, historyState, forgetHistory } = await import('./store/history.js')

    const start = await readMeeting(session.meetingId)
    const target = start?.utterances[0]
    if (!target) {
      log('nothing to edit, so the undo check is skipped')
    } else {
      const wasText = target.text
      check(!historyState(session.meetingId).canUndo, 'before any edit there is nothing to undo')

      await editWithHistory(session.meetingId, 'an utterance edit', (m) => ({
        ...m,
        utterances: m.utterances.map((u) => (u.id === target.id ? { ...u, text: 'replaced text' } : u))
      }))
      check(historyState(session.meetingId).canUndo, 'after an edit there is something to undo')

      const back = await undo(session.meetingId)
      check(back?.label === 'an utterance edit', 'undo names what it rolled back', back?.label ?? '—')
      check(
        back?.meeting.utterances.find((u) => u.id === target.id)?.text === wasText,
        'the utterance text went back to the original'
      )
      check(historyState(session.meetingId).canRedo, 'what was undone can be redone')

      const forward = await redo(session.meetingId)
      check(
        forward?.meeting.utterances.find((u) => u.id === target.id)?.text === 'replaced text',
        'redo brings the edit back'
      )

      // The recording goes back to its original state: later steps check it too.
      await undo(session.meetingId)
      check(
        (await readMeeting(session.meetingId))?.utterances.find((u) => u.id === target.id)?.text === wasText,
        'the recording is left as it was'
      )

      // A new edit cuts the redo branch off.
      await editWithHistory(session.meetingId, 'another edit', (m) => m)
      check(!historyState(session.meetingId).canRedo, 'a new edit cuts the redo branch off')

      // Cutting out a fragment changes the audio, and a snapshot will not bring it back, so history breaks.
      forgetHistory(session.meetingId)
      const empty = historyState(session.meetingId)
      check(!empty.canUndo && !empty.canRedo, 'an irreversible action breaks history')
      check((await undo(session.meetingId)) === null, 'on empty history undo does nothing')
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
      updateMeeting(session.meetingId, (m) => ({ ...m, tags: ['a mark'] })),
      updateMeeting(session.meetingId, (m) => ({ ...m, title: 'Queue check' }))
    ])
    const after = await readMeeting(session.meetingId)
    check(after?.tags[0] === 'a mark', 'a simultaneous edit of the marks survived')
    check(after?.title === 'Queue check', 'a simultaneous rename survived')
  }

  // ── marks ─────────────────────────────────────────────────────────────
  check(meeting.marks.length >= 0, 'the marks field is in place')

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
    check(second.meetingId === session.meetingId, 'a continuation is written into the same recording')

    const player2 = spawn('afplay', [fixture], { stdio: 'ignore' })
    await new Promise((resolve) => setTimeout(resolve, 5000))
    const secondMark = second.mark('the second part')
    player2.kill()
    const { durationSec: total } = await second.stop()

    check(total > beforeDuration + 3, 'the duration grew', `${beforeDuration.toFixed(1)} → ${total.toFixed(1)} s`)
    check(
      (secondMark?.at ?? 0) > beforeDuration,
      'the second part mark comes after the first',
      `${secondMark?.at.toFixed(1)} s`
    )
    check(second.currentMarks().length === beforeMarks + 1, 'the marks of the first part were kept')

    const wave = await readWavPcm16(audioFile(session.meetingId, 'system'))
    const wavSeconds = wave.samples.length / wave.sampleRate
    check(Math.abs(wavSeconds - total) < 2, 'the audio in the file matches the duration', `${wavSeconds.toFixed(1)} s`)

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
      check(!liveReady, 'a draft is absent only when there was no live transcription')
    } else {
      const lines = (await readFile(file, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { track: string; text: string; start: number })
        // Chunks of the two tracks are written interleaved, as they become ready; the
        // order is imposed by whoever reads them, and the handler does the same.
        .sort((a, b) => a.start - b.start)
      check(lines.length > 0, 'the draft was saved', `${lines.length} utterances`)
      check(
        lines.every((l) => (l.track === 'mic' || l.track === 'system') && l.text.length > 0),
        'the draft lines are whole'
      )
      check(
        lines.every((l, i) => i === 0 || l.start >= lines[i - 1]!.start),
        'the draft runs in increasing time'
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
    check(whileRemote < 0.45, 'while the other side speaks the microphone is ducked', whileRemote.toFixed(3))
    check(whileOwn > 0.2, 'your own speech stays loud', whileOwn.toFixed(3))

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
      check(false, 'there is a recording to check the stages on')
    } else {
      // Take a snapshot, then change the file around it, then write through the snapshot.
      const stale = before
      await updateMeeting(session.meetingId, (m) => ({
        ...m,
        stages: { ...m.stages, recording: 'done' },
        title: 'Changed around the snapshot'
      }))
      await updateMeeting(stale.id, (current) => ({
        ...current,
        stages: { ...current.stages, summarizing: 'done' }
      }))

      const after = await readMeeting(session.meetingId)
      check(after?.stages.recording === 'done', 'somebody else\'s stage edit survived the pipeline write')
      check(after?.title === 'Changed around the snapshot', 'somebody else\'s title edit was not wiped')
      check(after?.stages.summarizing === 'done', 'our own stage edit was applied')

      await updateMeeting(session.meetingId, (m) => ({ ...m, title: stale.title }))
    }
  }

  // ── silence must not breed invented text ──────────────────────────────
  // On an empty track Whisper produces credits out of its training data
  // ("Subtitles by...", "To be continued..."). We check that such tracks never
  // reach transcription at all.
  {
    const quiet = new RecordingSession({ mic: false, system: true, title: 'Silence check' }, [])
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
    check(invented.length === 0, 'on silence the transcript is empty', invented.map((u) => u.text).join(' | '))

    const { deleteMeeting } = await import('./store/meetings.js')
    await deleteMeeting(quiet.meetingId)
  }

  // ── cutting out a fragment ────────────────────────────────────────────
  // The most dangerous operation: it spoils audio already recorded and cannot be undone.
  {
    const before = await readMeeting(session.meetingId)
    const victim = before?.utterances[before.utterances.length - 1]
    if (!before || !victim) {
      check(false, 'there is something to cut out')
    } else {
      const { samples, sampleRate } = await readWavPcm16(audioFile(session.meetingId, 'system'))
      const lengthBefore = samples.length

      const { silenceRange } = await import('./audio/wav.js')
      const silenced = await silenceRange(audioFile(session.meetingId, 'system'), victim.start, victim.end)
      check(silenced > 0, 'the stretch was silenced', `${silenced.toFixed(1)} s`)

      const after = await readWavPcm16(audioFile(session.meetingId, 'system'))
      check(after.samples.length === lengthBefore, 'the file length did not change')

      const from = Math.floor(victim.start * sampleRate)
      const to = Math.min(after.samples.length, Math.ceil(victim.end * sampleRate))
      let peak = 0
      for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(after.samples[i]!))
      check(peak === 0, 'the cut stretch is really silent', `peak ${peak}`)

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
        'the rest of the recording is unharmed',
        `was ${outsideBefore.toFixed(3)}, became ${outsidePeak.toFixed(3)}`
      )

      const doomed = utterancesInRange(before, victim.start, victim.end)
      check(doomed.some((u) => u.id === victim.id), 'an utterance falls inside the stretch being cut')
    }
  }

  // ── cutting at silences for language detection ────────────────────────
  {
    const { splitOnSilence } = await import('./audio/wav.js')
    const source = audioFile(session.meetingId, 'system')
    const parts = await splitOnSilence(source, 6)
    const { samples, sampleRate } = await readWavPcm16(source)
    const whole = samples.length / sampleRate

    check(parts.length === 0 || parts.length > 1, 'cutting either leaves the recording alone or gives several pieces')

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
      check(cut.length > 1, 'a recording with pauses is cut into pieces', `${cut.length} of them`)
      let restored = 0
      for (const piece of cut) restored += (await readWavPcm16(piece.path)).samples.length / rate
      check(Math.abs(restored - 30) < 0.5, 'the pieces of the synthetic recording give the original 30 s', `${restored.toFixed(1)} s`)

      const cutsAtPauses = cut.slice(1).every((piece) => {
        const at = piece.offsetSec % 5
        // The boundary has to land in a pause, which runs from the 4th to the 5th second.
        return at >= 3.8 || at <= 0.2
      })
      check(cutsAtPauses, 'the cuts land in pauses rather than mid-phrase',
        cut.map((c) => c.offsetSec.toFixed(1)).join(', '))

      const { rm: remove } = await import('node:fs/promises')
      await Promise.all([...cut.map((c) => remove(c.path, { force: true })), remove(file, { force: true })])
    }

    if (parts.length === 0) {
      check(true, 'continuous speech is not cut', 'no suitable pauses were found')
    } else {
      let sum = 0
      for (const part of parts) sum += (await readWavPcm16(part.path)).samples.length / sampleRate
      check(Math.abs(sum - whole) < 0.5, 'the pieces add up to the original recording', `${sum.toFixed(1)} of ${whole.toFixed(1)} s`)
      check(parts[0]!.offsetSec === 0, 'the first piece starts at zero')
      const ordered = parts.every((p, i) => i === 0 || p.offsetSec > parts[i - 1]!.offsetSec)
      check(ordered, 'the offsets of the pieces increase')
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
      check(false, 'there is a recording to check simultaneous edits on')
    } else {
      await Promise.all([
        updateMeeting(session.meetingId, (m) => ({ ...m, tags: [...m.tags, 'first'] })),
        updateMeeting(session.meetingId, (m) => ({ ...m, tags: [...m.tags, 'second'] })),
        updateMeeting(session.meetingId, (m) => ({ ...m, title: 'Renamed on the fly' }))
      ])

      const after = await readMeeting(session.meetingId)
      check(after?.tags.includes('first') === true, 'the first simultaneous edit was kept')
      check(after?.tags.includes('second') === true, 'the second simultaneous edit was not lost')
      check(after?.title === 'Renamed on the fly', 'the third edit is there too')

      // A failed edit must not bring the queue down: the ones after it have to go through.
      await updateMeeting(session.meetingId, () => {
        throw new Error('a deliberate failure')
      }).catch(() => undefined)
      const survived = await updateMeeting(session.meetingId, (m) => ({ ...m, tags: [...m.tags, 'after the failure'] }))
      check(survived.tags.includes('after the failure'), 'the queue survives a failed edit')

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
    await writeFile(meetingFile(victim, 'meta.json'), '{ this is not json', 'utf8')

    const hidden = (await listMeetings()).some((m) => m.id === victim)
    check(!hidden, 'a damaged description really does hide the recording')

    await recoverOrphanedRecordings()
    const back = (await listMeetings()).find((m) => m.id === victim)
    check(back !== undefined, 'the recording came back to the list after recovery')
    check((back?.durationSec ?? 0) > 0, 'the duration was recovered from the audio', `${back?.durationSec.toFixed(1)} s`)
    check(
      back?.errors.recording !== undefined,
      'the damage is reported honestly rather than silently repaired',
      back?.errors.recording ?? ''
    )

    await copyFile(backup, meetingFile(victim, 'meta.json'))
    await remove(backup, { force: true })
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
    log(`models for the summary: ${ready.length > 0 ? ready.join(', ') : 'none'}`)

    if (ready.length === 0) {
      check(true, 'the summary was skipped', 'no model is ready')
    } else {
      for (const id of ready) {
        const provider = LLM_PROVIDERS.find((p) => p.id === id)!
        const answer = await provider
          .complete([{ role: 'user', content: 'Answer in one word: working' }], {})
          .catch((error: unknown) => `ERROR: ${error instanceof Error ? error.message : String(error)}`)
        check(!answer.startsWith('ERROR:'), `${id} answers`, answer.replace(/\s+/g, ' ').slice(0, 70))
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
      'a /v1 path is appended to an address without one')
    check(normalizeBaseUrl('https://x.dev/v1/') === 'https://x.dev/v1', 'a trailing slash is trimmed')

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
        res.end(JSON.stringify({ choices: [{ message: { content: '  a finished summary  ' } }] }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port

    const before = await loadSettings()
    await saveSettings({ openAiCompatible: { baseUrl: `http://127.0.0.1:${port}`, model: 'test/model' } })
    await setSecret('openai-compatible.key', 'sk-test-0123456789')

    const ready = await openAiCompatibleProvider.ready()
    check(ready.ready, 'a configured service counts as ready', ready.hint ?? '')

    const answer = await openAiCompatibleProvider.complete(
      [
        { role: 'system', content: 'you make summaries' },
        { role: 'user', content: 'here is the transcript' }
      ],
      {}
    )
    check(answer === 'a finished summary', 'the answer is parsed and trimmed at the edges', answer)
    check(seen.path === '/v1/chat/completions', 'the request went to the right path', seen.path ?? '')
    check(seen.auth === 'Bearer sk-test-0123456789', 'the key was put into the header')

    // A key with stray characters has to give a clear error rather than a failure
    // inside fetch.
    // Cyrillic on purpose: only ASCII is allowed in a header, and this is the
    // case that has to produce a readable error instead of failing inside fetch.
    await setSecret('openai-compatible.key', 'ключ-с-кириллицей')
    const broken = await openAiCompatibleProvider
      .complete([{ role: 'user', content: 'x' }], {})
      .then(() => '')
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
    // Compared against words of the same translation rather than the Russian text:
    // otherwise the check failed when the interface was switched to English.
    check(
      broken === t('в ключе есть посторонние символы — скопируйте его заново, без пробелов и кавычек'),
      'a damaged key is explained in words',
      broken.slice(0, 60)
    )
    await setSecret('openai-compatible.key', 'sk-test-0123456789')
    check(seen.body?.model === 'test/model', 'the model was passed as given')
    check(Array.isArray(seen.body?.messages) && (seen.body!.messages as unknown[]).length === 2,
      'the messages arrived whole')
    check(seen.body?.stream === false, 'streaming mode is off')

    // A service error has to be shown in words, not as a code.
    server.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const failed = await openAiCompatibleProvider
      .complete([{ role: 'user', content: 'x' }], {})
      .then(() => '')
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
    check(failed.length > 0, 'an unreachable service gives a clear error', failed.slice(0, 60))

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

    check(cold < 3000, 'finding similar ones cold keeps within three seconds', `${cold} ms over ${total} recordings`)
    check(warm < 300, 'opening it again is instant', `${warm} ms`)

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
    check(digestMs < 4000, 'a digest for a quarter is assembled quickly', `${digestMs} ms over ${loaded.length} recordings`)
    check(digest.meetings === loaded.length, 'the digest covers every recording of the period')
  }

  log('')
  // The check writes a real recording into the real store. It must not be left
  // there: over a few runs a person's list of recordings fills up with rubbish.
  // SPYLY_KEEP=1 helps when looking into a failed run.
  if (process.env.SPYLY_KEEP || failures > 0) {
    log(`files: ${meetingDir(session.meetingId)}`)
  } else {
    const { deleteMeeting } = await import('./store/meetings.js')
    await deleteMeeting(session.meetingId)
    log('the check recording was deleted')
  }
  log(failures === 0 ? '=== everything holds ===' : `=== failures: ${failures} ===`)
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
      log('waiting for the audio to be freed by a neighbouring run…')
      waited = true
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  log('the audio is still busy; the check may show empty tracks')
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
