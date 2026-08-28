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
 * Сквозная проверка: реальная запись → расшифровка → разделение по голосам.
 *
 * Запускается как `electron apps/desktop --selftest <файл.wav>`: файл
 * проигрывается внешним процессом, поэтому проверяется именно захват
 * системного звука, а не подсовывание готовых данных в конвейер.
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
   * Ждём, пока освободится звук.
   *
   * Проверка играет файл и ловит его системным захватом. Если рядом ещё
   * доживает прошлый прогон, устройство занято, и запись выходит пустой —
   * тест падает по причине, к продукту отношения не имеющей.
   */
  await waitForAudioFree(log)

  const settings = await loadSettings()
  log(`язык расшифровки: ${settings.language}`)

  // Модель для живого режима грузится секунды; в приложении её прогревает
  // диалог выбора источников, здесь — делаем это до старта записи, иначе
  // прогрев попал бы в её длительность.
  //
  // Задержку считаем честно: сколько прошло от момента, когда слово прозвучало,
  // до момента, когда его текст оказался на руках. Именно её видит человек.
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
   * Когда по каждой дорожке пришёл первый сэмпл.
   *
   * Отсчитывать от старта записи нельзя: источник может начать отдавать звук
   * с задержкой в секунды (в проверке — пока не заиграет файл), и эта пауза
   * записалась бы в задержку расшифровки, которой там нет.
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
    // Пишем черновик так же, как рабочий путь: по нему живёт вкладка
    // «Черновик» и видит идущий разговор агент через MCP.
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

  // Играем чужим процессом: свой звук исключается из захвата.
  const player = spawn('afplay', [fixture], { stdio: 'ignore' })
  await new Promise((resolve) => setTimeout(resolve, (seconds / 2) * 1000))
  const markResult = session.mark('проверка')
  await new Promise((resolve) => setTimeout(resolve, (seconds / 2) * 1000))
  player.kill()

  const { durationSec } = await session.stop()
  log(`запись остановлена, длительность ${durationSec.toFixed(1)} с`)

  // Хвост последней фразы досчитывается уже после остановки.
  await new Promise((resolve) => setTimeout(resolve, 4000))
  stopWhisperServer()
  if (liveReady) {
    check(liveTexts.length > 0, 'живая расшифровка выдала текст', `${liveTexts.length} обновлений`)
    const lags = liveTexts.map((t) => t.lagSec).filter((lag) => Number.isFinite(lag))
    const worst = lags.length > 0 ? Math.max(...lags) : 0
    if (streamingLive) {
      // Смысл потоковой модели в том, что слова видны почти сразу. Порог с
      // запасом на медленную машину, но заведомо ниже прежних десятков секунд.
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
  // --- название по смыслу ---
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
  // ── файлы на диске ────────────────────────────────────────────────────
  const { existsSync: exists } = await import('node:fs')
  const { readFile } = await import('node:fs/promises')
  for (const name of ['meta.json', 'transcript.json', 'transcript.md']) {
    check(exists(path.join(meetingDir(session.meetingId), name)), `на диске есть ${name}`)
  }
  const markdown = await readFile(path.join(meetingDir(session.meetingId), 'transcript.md'), 'utf8')
  check(markdown.includes('## Расшифровка'), 'markdown-расшифровка собрана')
  check(markdown === renderTranscriptMarkdown(meeting), 'markdown на диске совпадает с текущим состоянием')

  // --- отмена и возврат правок ---
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

      // Возвращаем запись в исходное состояние: дальше её проверяют другие шаги.
      await undo(session.meetingId)
      check(
        (await readMeeting(session.meetingId))?.utterances.find((u) => u.id === target.id)?.text === wasText,
        'запись оставлена в исходном виде'
      )

      // Новая правка обрывает ветку возврата.
      await editWithHistory(session.meetingId, 'ещё правку', (m) => m)
      check(!historyState(session.meetingId).canRedo, 'новая правка обрывает возврат')

      // Вырезание фрагмента меняет звук, снимок его не вернёт — история рвётся.
      forgetHistory(session.meetingId)
      const empty = historyState(session.meetingId)
      check(!empty.canUndo && !empty.canRedo, 'необратимое действие обрывает историю')
      check((await undo(session.meetingId)) === null, 'на пустой истории отмена ничего не делает')
    }
  }

  // --- одновременные правки не теряют друг друга ---
  {
    // Здесь была потеря данных: переименование и смена имени участника шли
    // мимо общей очереди — отдельными чтением и записью. Правка, пришедшая
    // между ними, пропадала; конвейер, дописывающий запись по ходу обработки,
    // попадал в это окно постоянно.
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

  // --- пересборка не с самого начала ---
  {
    // Здесь была потеря данных: запуск обработки «с разделения по голосам»
    // собирал расшифровку из пустоты и стирал её целиком.
    const before = (await readMeeting(session.meetingId))?.utterances.length ?? 0
    if (before > 0) {
      await processMeeting(session.meetingId, 'diarizing')
      const after = (await readMeeting(session.meetingId))?.utterances.length ?? 0
      check(after > 0, 'расшифровка переживает пересборку по голосам', `${before} → ${after} реплик`)
    }
  }


  // ── узнавание участников по голосу ────────────────────────────────────
  // Состояние читаем заново: проверка выше пересобирает участников, и
  // прочитанный раньше список к этому моменту уже не тот — в собранном
  // приложении разделение по голосам дало другие кластеры, и слепок снимался
  // с идентификатора, которого больше нет.
  const fresh = await readMeeting(session.meetingId)
  const firstSpeaker = fresh?.speakers[0]
  if (firstSpeaker) {
    const before = (await listVoices()).length
    const profile = await rememberSpeaker(session.meetingId, firstSpeaker.id, 'Тестовый участник')
    check(profile !== null, 'слепок голоса сохранён')
    check((await listVoices()).length === before + 1, 'профиль появился в реестре')

    // Голос участника мог не узнаться сам: слепок шумный, реплик мало. Тогда
    // его привязывают к уже знакомому голосу — выбором имени из списка. Второй
    // слепок при этом не заводится, а существующий уточняется этой записью.
    const again = await rememberSpeaker(session.meetingId, firstSpeaker.id, 'Тестовый участник')
    check((await listVoices()).length === before + 1, 'привязка к знакомому голосу не плодит слепков')
    check(
      (again?.samples ?? 0) > (profile?.samples ?? 0),
      'слепок уточнился новой записью',
      `${profile?.samples} → ${again?.samples}`
    )

    if (profile) {
      // Прогоняем узнавание на той же записи: участник должен опознаться.
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

  // ── словарь доходит до движка ─────────────────────────────────────────
  {
    const { buildVocabularyPrompt } = await import('./providers/asr/whisper-cpp.js')
    const { listVoices: voices } = await import('./store/voices.js')
    const prompt = await buildVocabularyPrompt()
    // В подсказку попадает не только словарь: имена из реестра голосов тоже —
    // ради них она во многом и нужна. К этому месту тест уже записал слепок,
    // поэтому пустой подсказка быть не должна.
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

  // ── метки ─────────────────────────────────────────────────────────────
  check(meeting.marks.length >= 0, 'поле отметок на месте')

  // ── продолжение записи ────────────────────────────────────────────────
  // Самая рискованная часть: дозапись идёт в существующий WAV, и ошибка здесь
  // портит уже записанный разговор, а не только новую часть.
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
      // Этап записи обязательно закрываем: иначе в списке навсегда останется
      // крутящийся кружок рядом с уже готовой расшифровкой.
      await writeMeta({
        ...metaOf(continued),
        durationSec: total,
        endedAt: new Date().toISOString(),
        marks: second.currentMarks(),
        stages: { ...continued.stages, recording: 'done' }
      })
    }
  }

  // ── черновик живой расшифровки ────────────────────────────────────────
  // Раньше он удалялся после обработки. Теперь остаётся: по нему видно, что
  // было на экране во время разговора, — отдельной вкладкой.
  {
    const file = meetingFile(session.meetingId, 'live.jsonl')
    if (!existsSync(file)) {
      check(!liveReady, 'черновик отсутствует только когда живой расшифровки не было')
    } else {
      const lines = (await readFile(file, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { track: string; text: string; start: number })
        // Куски двух дорожек пишутся вперемешку, по мере готовности; порядок
        // наводит тот, кто читает, — так же делает и обработчик.
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

  // ── сведение приглушает эхо ───────────────────────────────────────────
  // Голос собеседника звучит из динамиков и попадает в микрофон: в простой
  // сумме он оказывается дважды. Проверяем, что при сведении микрофон
  // приглушается там, где говорит собеседник.
  {
    const { mixTracks: mix, writeWavPcm16: write, readWavPcm16: read } = await import('./audio/wav.js')
    const rate = 16000
    const seconds = 4
    const micTrack = new Float32Array(rate * seconds)
    const sysTrack = new Float32Array(rate * seconds)

    // Первые две секунды говорит собеседник, и микрофон ловит его эхо.
    // Последние две — говорит человек, собеседник молчит.
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
    // Пока говорит собеседник, вклад микрофона приглушён, поэтому уровень
    // близок к его собственному, а не к сумме двух голосов.
    const whileRemote = energy(rate / 2, rate * 1.5)
    const whileOwn = energy(rate * 2.5, rate * 3.5)
    check(whileRemote < 0.45, 'при речи собеседника микрофон приглушён', whileRemote.toFixed(3))
    check(whileOwn > 0.2, 'собственная речь остаётся громкой', whileOwn.toFixed(3))

    const { rm: remove } = await import('node:fs/promises')
    await Promise.all([micFile, sysFile, outFile].map((f) => remove(f, { force: true })))
  }

  // ── этапы не затираются устаревшим снимком ────────────────────────────
  // Конвейер держит запись в памяти минутами; если он пишет её целиком, то
  // затирает всё, что за это время поменялось, — так у записи оставался
  // крутящийся этап «Запись» при готовой расшифровке.
  {
    const { updateMeeting } = await import('./store/meetings.js')
    const before = await readMeeting(session.meetingId)
    if (!before) {
      check(false, 'есть запись для проверки этапов')
    } else {
      // Берём снимок, потом меняем файл мимо него, потом пишем через снимок.
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

  // ── тишина не должна порождать выдумок ────────────────────────────────
  // Whisper на пустой дорожке выдаёт титры из обучающих данных
  // («Редактор субтитров…», «Продолжение следует…»). Проверяем, что до
  // расшифровки такие дорожки вообще не доходят.
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

  // ── правка расшифровки ────────────────────────────────────────────────
  // Разделить, склеить, переназначить говорящего, вырезать. Всё это пишет на
  // диск, поэтому проверяем на настоящих файлах, а не на выдуманных данных.
  {
    const before = await readMeeting(session.meetingId)
    const target = before?.utterances[0]
    if (!before || !target) {
      check(false, 'есть реплика для правки')
    } else {
      // Делим по пробелу: посреди слова деление законно вставляет границу, и
      // сравнивать склейку с исходным текстом было бы бессмысленно.
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

      // Уверенность по словам нужна подсветке сомнительных мест.
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

  // ── вырезание фрагмента ───────────────────────────────────────────────
  // Самая опасная операция: она портит уже записанный звук и необратима.
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

      // За пределами промежутка звук должен остаться нетронутым. Смотрим
      // обе стороны: начало записи бывает тихим само по себе, и проверка по
      // одному только началу падала на ровном месте.
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

  // ── резка по тишине для автоопределения языка ─────────────────────────
  {
    const { splitOnSilence } = await import('./audio/wav.js')
    const source = audioFile(session.meetingId, 'system')
    const parts = await splitOnSilence(source, 6)
    const { samples, sampleRate } = await readWavPcm16(source)
    const whole = samples.length / sampleRate

    check(parts.length === 0 || parts.length > 1, 'резка либо не трогает запись, либо даёт несколько кусков')

    // Отдельно — файл с заведомыми паузами: на живой фикстуре подходящих
    // разрывов может не найтись, и настоящая резка осталась бы непроверенной.
    {
      const { writeWavPcm16 } = await import('./audio/wav.js')
      const rate = 16000
      const synthetic = new Float32Array(rate * 30)
      for (let i = 0; i < synthetic.length; i++) {
        const second = i / rate
        // Речь по 4 секунды, паузы по секунде — как в обычном разговоре.
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
        // Граница должна попадать в паузу — она идёт с 4-й по 5-ю секунду.
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

  // ── одновременные правки ──────────────────────────────────────────────
  // Конспект правит человек, задачи дописывает агент через MCP, а конвейер в
  // это же время сохраняет этап. Без очереди правка, начатая раньше, молча
  // затирала бы ту, что закончилась позже.
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

      // Неудачная правка не должна ронять очередь: следующие обязаны пройти.
      await updateMeeting(session.meetingId, () => {
        throw new Error('нарочная ошибка')
      }).catch(() => undefined)
      const survived = await updateMeeting(session.meetingId, (m) => ({ ...m, tags: [...m.tags, 'после сбоя'] }))
      check(survived.tags.includes('после сбоя'), 'очередь переживает неудачную правку')

      await updateMeeting(session.meetingId, (m) => ({ ...m, tags: [], title: target.title }))
    }
  }

  // ── битое описание записи ─────────────────────────────────────────────
  // Испорченный meta.json прятал запись из списка целиком: звук на диске,
  // а в приложении её нет. Проверяем, что она возвращается.
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

  // ── словарь учится на правках ─────────────────────────────────────────
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

  // ── конспект настоящей моделью ────────────────────────────────────────
  // Именно здесь всплыл бы запуск codex без node в PATH: сам файл находится,
  // а `#!/usr/bin/env node` внутри падает с кодом 127.
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

  // ── свой OpenAI-совместимый сервис ────────────────────────────────────
  // Через него подключают OpenRouter и подобные. Проверяем весь путь на
  // локальной заглушке: настройки, ключ, форма запроса, разбор ответа.
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

    // Ключ с посторонними символами обязан давать понятную ошибку, а не
    // падение внутри fetch.
    await setSecret('openai-compatible.key', 'ключ-с-кириллицей')
    const broken = await openAiCompatibleProvider
      .complete([{ role: 'user', content: 'x' }], {})
      .then(() => '')
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
    // Сравниваем со словами того же перевода, а не с русским текстом: иначе
    // проверка падала, когда интерфейс переключён на английский.
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

    // Ошибку сервиса надо показывать словами, а не кодом.
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

  // ── скорость на большом архиве ────────────────────────────────────────
  // Похожие записи ищутся при каждом открытии страницы: если это стоит
  // секунды, окно будет замирать на каждом клике.
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

    // Итоги читают весь период целиком — за квартал это может быть весь архив.
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
  // Проверка пишет настоящую запись в настоящее хранилище. Оставлять её там
  // нельзя: за несколько прогонов список записей человека забивается мусором.
  // Разобраться в упавшем прогоне поможет SPYLY_KEEP=1.
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

/** Мета без расшифровки: продолжению нужна только она. */
function metaOf(meeting: Meeting): MeetingMeta {
  const { speakers, utterances, summary, ...meta } = meeting
  return meta
}

/** Есть ли рядом чужой захват звука — он мешает проверке. */
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
      // Процесс вышел, но CoreAudio отпускает приватный агрегат не мгновенно:
      // захват, начатый сразу, получает тишину вместо звука.
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
  // Без имени файла `path.resolve('')` даёт текущую папку, а она существует —
  // проверка уходила дальше и падала пятью загадочными провалами вместо
  // внятного «файл не указан».
  const raw = process.argv[index + 1] ?? ''
  const fixture = raw.trim() && !raw.startsWith('--') ? path.resolve(raw) : ''
  const seconds = Number(process.argv[index + 2] ?? 20)
  return { fixture, seconds: Number.isFinite(seconds) ? seconds : 20 }
}

export { app }
