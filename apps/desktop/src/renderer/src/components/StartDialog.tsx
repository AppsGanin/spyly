import { t } from '@spyly/core'
import { useEffect, useState } from 'react'
import type { AudioApp, AudioDevice, CalendarEventInfo, Permissions, StartRecordingOptions } from '@shared/ipc'
import { api, useIpcEvent } from '../lib/api'
import { IconCalendar, IconMic, IconSpeaker } from '../lib/icons'
import { useStore } from '../lib/store'
import { Button, Meter, Modal, Select, Switch } from '../ui'

/**
 * Выбор источников перед записью.
 *
 * Уровни идут вживую ещё до старта: на macOS поток может быть формально живым,
 * но пустым, и без этой проверки пользователь узнал бы о тишине только после
 * созвона.
 */
/**
 * Микрофоны глазами Chromium.
 *
 * Названия появляются только после того, как разрешение на микрофон уже
 * выдано; до этого приходят пустые метки, и вместо них показываем понятное
 * «Микрофон 1».
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
  const [event, setEvent] = useState<CalendarEventInfo | null>(null)
  const [useEvent, setUseEvent] = useState(true)

  useIpcEvent('audio:levels', setLevels)

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

      // Календарь знает название встречи и участников — это лучше, чем
      // «Запись 27 августа» и «Участник 2» в архиве.
      const found = await api.call('calendar:current')
      if (!cancelled) setEvent(found)

      // На Windows и Linux списка микрофонов у главного процесса нет —
      // нативного хелпера там не существует. Спрашиваем у самого браузера.
      setMics(deviceList.length > 0 ? deviceList : await browserMics())
      setApps(appList)
      setPermissions(perms)
      setMicDevice((current) => current || deviceList[0]?.id || '')
      // Выключаем источник, на который нет разрешения: иначе запись стартует
      // и молча пишет тишину.
      if (perms.microphone === 'denied') setMicOn(false)
      if (perms.systemAudio === 'denied') setSystemOn(false)
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  // Проба слушает звук, пока диалог открыт, и обязательно останавливается
  // при закрытии — иначе микрофон останется занятым.
  useEffect(() => {
    if (!open) return
    void api.call('audio:startProbe', {
      micDeviceId: micDevice || undefined,
      systemApps: scope === 'apps' ? selectedApps : undefined
    })
    return () => {
      void api.call('audio:stopProbe')
      setLevels({ mic: 0, system: 0 })
    }
  }, [open, micDevice, scope, selectedApps])

  const toggleApp = (key: string) => {
    setSelectedApps((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
  }

  const micBlocked = permissions?.microphone === 'denied'
  const systemBlocked = permissions?.systemAudio === 'denied'
  const canStart = (micOn && !micBlocked) || (systemOn && !systemBlocked)

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
        title: linked ? event.title : undefined,
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
                  <div className="check__title">{event.title}</div>
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

        {!canStart && (
          <p className="check__hint" style={{ color: 'var(--ds-amber-900)' }}>{t('Нужен хотя бы один доступный источник звука.')}</p>
        )}
        {asrReady && !asrReady.ready && (
          <p className="check__hint" style={{ color: 'var(--ds-amber-900)' }}>
            {t('Записать можно, но расшифровать пока нечем: {hint}. Звук сохранится, и текст появится, когда модель будет на месте.', { hint: asrReady.hint ?? t('движок не готов') })}
          </p>
        )}
        <p className="check__hint">{t('Предупредите собеседников о записи: в большинстве стран этого требует закон.')}</p>
      </div>
    </Modal>
  )
}
