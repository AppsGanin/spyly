import { t } from '@spyly/core'
import { useEffect, useState } from 'react'
import type { AudioApp, AudioDevice, CalendarEventInfo, ModelInfo, Permissions, StartRecordingOptions } from '@shared/ipc'
import { api, useIpcEvent } from '../lib/api'
import { IconCalendar, IconMic, IconSpeaker } from '../lib/icons'
import { useStore } from '../lib/store'
import { Button, Meter, Modal, Select, Spinner, Switch } from '../ui'

/**
 * Choosing the sources before recording.
 *
 * The levels run live before the start: on macOS a stream can be formally
 * alive yet empty, and without this check the user would learn about the
 * silence only after the call.
 */
/**
 * Microphones as Chromium sees them.
 *
 * The names only appear once microphone permission has been granted; before
 * that the labels come through empty, and a readable "Microphone 1" is shown
 * instead.
 */
async function browserMics(): Promise<{ id: string; name: string }[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices
      .filter((device) => device.kind === 'audioinput')
      .map((device, index) => ({
        id: device.deviceId,
        name: device.label || t('Микрофон {n}', { n: index + 1 })
      }))
  } catch {
    return []
  }
}

export function StartDialog({
  open,
  onClose,
  onStarted
}: {
  open: boolean
  onClose: () => void
  onStarted: () => void
}) {
  const { notify } = useStore()
  const [mics, setMics] = useState<AudioDevice[]>([])
  const [apps, setApps] = useState<AudioApp[]>([])
  const [micOn, setMicOn] = useState(true)
  const [systemOn, setSystemOn] = useState(true)
  const [micDevice, setMicDevice] = useState<string>('')
  const [scope, setScope] = useState<'all' | 'apps'>('all')
  const [selectedApps, setSelectedApps] = useState<string[]>([])
  const [levels, setLevels] = useState({ mic: 0, system: 0 })
  const [starting, setStarting] = useState(false)
  const [permissions, setPermissions] = useState<Permissions | null>(null)
  const [asrReady, setAsrReady] = useState<{ ready: boolean; hint?: string } | null>(null)
  const [asrModel, setAsrModel] = useState<ModelInfo | null>(null)
  const [event, setEvent] = useState<CalendarEventInfo | null>(null)
  const [useEvent, setUseEvent] = useState(true)

  useIpcEvent('audio:levels', setLevels)

  // The download runs in the main process; its progress reaches us as events.
  useIpcEvent('models:progress', (model) => {
    setAsrModel((current) => (current && model.id === current.id ? model : current))
    if (model.downloaded) void api.call('settings:providers').then((list) => {
      const engine = list.find((p) => p.kind === 'asr')
      setAsrReady(engine ? { ready: engine.ready, hint: engine.hint } : null)
    })
  })

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      const [deviceList, appList, perms, providers] = await Promise.all([
        api.call('audio:listMics'),
        api.call('audio:listApps'),
        api.call('app:permissions'),
        api.call('settings:providers')
      ])
      if (cancelled) return
      const engine = providers.find((p) => p.kind === 'asr')
      setAsrReady(engine ? { ready: engine.ready, hint: engine.hint } : null)

      // On Windows and Linux the main process has no list of microphones, as no
      // native helper exists there. We ask the browser itself.
      setMics(deviceList.length > 0 ? deviceList : await browserMics())
      setApps(appList)
      // Before the permissions, so that the level meter starts once, on the
      // right device, rather than starting and restarting.
      setMicDevice((current) => current || deviceList[0]?.id || '')

      /*
       * The question about the microphone is asked here, not at the start of a
       * recording.
       *
       * Until it is asked, macOS neither refuses nor prompts: the capture opens
       * and hands over exact zeros. Just below this dialog says "say something,
       * the bar should come alive", and the bar stays dead however loudly one
       * speaks. So the question comes before the promise.
       */
      const answered =
        perms.microphone === 'not-determined' && micOn
          ? await api.call('app:requestPermission', 'microphone')
          : perms
      if (cancelled) return
      // This starts the level meter, so nothing slow may stand in front of it.
      setPermissions(answered)
      // A source without permission is switched off: otherwise the recording starts
      // and silently writes silence.
      if (answered.microphone === 'denied') setMicOn(false)
      if (answered.systemAudio === 'denied') setSystemOn(false)

      // The calendar comes last: it knows the meeting name and the participants,
      // which beats "Recording, 27 August" in the archive, but reading it means
      // a helper process and EventKit — seconds during which the meter would
      // otherwise be standing still.
      const found = await api.call('calendar:current')
      if (!cancelled) setEvent(found)

      // Which model the recording would be transcribed with, so that the state
      // of the download can be shown rather than a bare "the engine is not
      // ready". Last of all: this is a warning, and warnings do not go in front
      // of the level meter.
      if (!engine?.ready) {
        const models = await api.call('models:list')
        if (cancelled) return
        const asr = models.filter((m) => m.purpose === 'asr')
        setAsrModel(asr.find((m) => m.downloading) ?? asr.find((m) => m.paused) ?? asr[0] ?? null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  // The probe listens while the dialog is open and always stops on close,
  // otherwise the microphone stays busy. It waits for the permissions: a probe
  // started before the answer goes on handing over silence after it.
  useEffect(() => {
    if (!open || !permissions) return
    void api.call('audio:startProbe', {
      micDeviceId: micDevice || undefined,
      systemApps: scope === 'apps' ? selectedApps : undefined
    })
    return () => {
      void api.call('audio:stopProbe')
      setLevels({ mic: 0, system: 0 })
    }
  }, [open, micDevice, scope, selectedApps, permissions])

  const toggleApp = (key: string) => {
    setSelectedApps((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
  }

  const micBlocked = permissions?.microphone === 'denied'
  const systemBlocked = permissions?.systemAudio === 'denied'
  const hasSource = (micOn && !micBlocked) || (systemOn && !systemBlocked)
  // Recording without a model is recording into a void: the sound would be
  // saved and there would be nothing to turn it into text with. Better to wait
  // out the download than to find that out after the conversation.
  const canStart = hasSource && asrReady?.ready === true

  const start = async () => {
    if (!canStart) return
    setStarting(true)
    try {
      await api.call('audio:stopProbe')
      const linked = event && useEvent
      const options: StartRecordingOptions = {
        mic: micOn,
        system: systemOn,
        micDeviceId: micDevice || undefined,
        systemApps: scope === 'apps' && selectedApps.length ? selectedApps : undefined,
        title: linked && event.title ? event.title : undefined,
        calendarEventId: linked ? event.id : undefined,
        calendarParticipants: linked ? event.participants : undefined
      }
      await api.call('rec:start', options)
      onStarted()
    } catch (error) {
      notify('error', error instanceof Error ? error.message : String(error))
    } finally {
      setStarting(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('Новая запись')}
      actions={
        <>
          <Button onClick={onClose}>{t('Отмена')}</Button>
          <Button variant="primary" onClick={() => void start()} disabled={starting || !canStart}>
            {starting ? t('Запускаю…') : t('Начать запись')}
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 'var(--space-4)' }}>
        <div className="check">
          <span className="check__icon"><IconMic /></span>
          <div className="check__body">
            <div className="spread">
              <span className="check__title">{t('Микрофон')}</span>
              <Switch checked={micOn} onChange={setMicOn} label={t('Писать микрофон')} />
            </div>
            {micBlocked && (
              <div className="check__hint" style={{ color: 'var(--ds-amber-900)', marginTop: 4 }}>
                {t('Нет разрешения на микрофон.')}{' '}
                <button className="linklike" onClick={() => void api.call('app:openPrivacySettings', 'microphone')}>{t('Открыть настройки')}</button>
              </div>
            )}
            {micOn && !micBlocked && (
              <div className="col" style={{ gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
                {mics.length > 1 && (
                  <Select value={micDevice} onChange={(e) => setMicDevice(e.target.value)} aria-label={t('Устройство')}>
                    {mics.map((device) => (
                      <option key={device.id} value={device.id}>
                        {device.name}
                      </option>
                    ))}
                  </Select>
                )}
                <Meter level={levels.mic} />
                <span className="check__hint">
                  {levels.mic > 0.002 ? t('Слышу вас') : t('Скажите что-нибудь: полоска должна ожить')}
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="check">
          <span className="check__icon"><IconSpeaker /></span>
          <div className="check__body">
            <div className="spread">
              <span className="check__title">{t('Звук собеседников')}</span>
              <Switch checked={systemOn} onChange={setSystemOn} label={t('Писать системный звук')} />
            </div>
            {systemBlocked && (
              <div className="check__hint" style={{ color: 'var(--ds-amber-900)', marginTop: 4 }}>
                {t('Нет разрешения на запись системного звука.')}{' '}
                <button className="linklike" onClick={() => void api.call('app:openPrivacySettings', 'systemAudio')}>{t('Открыть настройки')}</button>
              </div>
            )}
            {systemOn && !systemBlocked && (
              <div className="col" style={{ gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
                <Select value={scope} onChange={(e) => setScope(e.target.value as 'all' | 'apps')} aria-label={t('Источник')}>
                  <option value="all">{t('Весь звук системы')}</option>
                  <option value="apps">{t('Только выбранные приложения')}</option>
                </Select>

                {scope === 'apps' && (
                  <div className="applist">
                    {apps.length === 0 && <span className="check__hint">{t('Приложений со звуком не найдено')}</span>}
                    {apps.map((app) => (
                      <label key={app.key} className="appitem">
                        <input
                          type="checkbox"
                          checked={selectedApps.includes(app.key)}
                          onChange={() => toggleApp(app.key)}
                        />
                        <span className="grow truncate">{app.name}</span>
                        {app.isPlaying && <span className="badge badge--green">{t('звучит')}</span>}
                      </label>
                    ))}
                  </div>
                )}

                <Meter level={levels.system} />
                <span className="check__hint">
                  {levels.system > 0.002
                    ? t('Системный звук слышно')
                    : t('Включите звук у собеседника: полоска должна ожить')}
                </span>
              </div>
            )}
          </div>
        </div>


        {event && (
          <label className={`check ${useEvent ? 'check--selected' : ''}`} style={{ cursor: 'pointer' }}>
            <span className="check__icon"><IconCalendar /></span>
            <div className="check__body">
              <div className="spread">
                <div className="grow">
                  <div className="check__title">{event.title || t('Без названия')}</div>
                  <div className="check__hint">
                    {event.isNow ? t('Идёт сейчас') : t('Скоро начнётся')}
                    {event.participants.length > 0 && ` · ${event.participants.join(', ')}`}
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={useEvent}
                  onChange={(e) => setUseEvent(e.target.checked)}
                  aria-label={t('Связать запись с этой встречей')}
                />
              </div>
            </div>
          </label>
        )}

        {!hasSource && (
          <p className="check__hint" style={{ color: 'var(--ds-amber-900)' }}>{t('Нужен хотя бы один доступный источник звука.')}</p>
        )}
        {asrReady && !asrReady.ready && <AsrModelState model={asrModel} hint={asrReady.hint} />}
        <p className="check__hint">{t('Предупредите собеседников о записи: в большинстве стран этого требует закон.')}</p>
      </div>
    </Modal>
  )
}

/**
 * The state of the model the recording will be transcribed with.
 *
 * It used to say "you can record, but there is nothing to transcribe with" and
 * let the recording start. That is a promise the application cannot keep: the
 * sound is saved and stays sound. So the download is shown here instead, and
 * the start waits for it.
 */
function AsrModelState({ model, hint }: { model: ModelInfo | null; hint?: string }) {
  const [asked, setAsked] = useState(false)

  if (!model) {
    return (
      <p className="check__hint" style={{ color: 'var(--ds-amber-900)' }}>
        {t('Нечем расшифровать: {hint}', { hint: hint ?? t('движок не готов') })}
      </p>
    )
  }

  const running = model.downloading === true
  const percent = Math.round((model.progress ?? 0) * 100)

  return (
    <div className="col" style={{ gap: 'var(--space-2)' }}>
      <div className="row" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
        {running && <Spinner />}
        <span className="check__hint" style={{ color: 'var(--ds-amber-900)' }}>
          {running
            ? t('Качаю модель «{name}» — {percent}%. Запись начнётся, когда она будет на месте.', {
                name: model.name,
                percent
              })
            : t('Модель «{name}» ещё не скачана — расшифровывать будет нечем.', { name: model.name })}
        </span>
      </div>
      {!running && (
        <Button
          size="sm"
          disabled={asked}
          onClick={() => {
            setAsked(true)
            void api.call('models:download', model.id)
          }}
        >
          {model.paused ? t('Продолжить загрузку') : t('Скачать модель')}
        </Button>
      )}
    </div>
  )
}
