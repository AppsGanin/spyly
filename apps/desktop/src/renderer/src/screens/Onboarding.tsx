import { t } from '@spyly/core'
import { useEffect, useState, type ReactNode } from 'react'
import type { ModelInfo, Permissions } from '@shared/ipc'
import { api, useIpcEvent } from '../lib/api'
import { IconAlert, IconCheck, IconMic, IconSparkle, IconSpeaker, IconUsers } from '../lib/icons'
import { useStore } from '../lib/store'
import { Button, Meter, Spinner } from '../ui'

type Step = 'welcome' | 'permissions' | 'check' | 'models' | 'done'

const STEPS: Step[] = ['welcome', 'permissions', 'check', 'models', 'done']

export function Onboarding() {
  const { saveSettings, notify } = useStore()
  const [step, setStep] = useState<Step>('welcome')
  const index = STEPS.indexOf(step)

  const go = (next: Step) => setStep(next)

  const finish = async () => {
    await saveSettings({ onboardingDone: true })
    notify('success', t('Настройка закончена'))
  }

  return (
    <div className="onboarding">
      <div className="onboarding__card">
        <div className="onboarding__steps" aria-hidden="true">
          {STEPS.map((s, i) => (
            <span key={s} className={`onboarding__step ${i <= index ? 'onboarding__step--done' : ''}`} />
          ))}
        </div>

        {step === 'welcome' && <Welcome onNext={() => go('permissions')} />}
        {step === 'permissions' && <PermissionsStep onNext={() => go('check')} onBack={() => go('welcome')} />}
        {step === 'check' && <SoundCheck onNext={() => go('models')} onBack={() => go('permissions')} />}
        {step === 'models' && <ModelsStep onNext={() => go('done')} onBack={() => go('check')} />}
        {step === 'done' && <Done onFinish={() => void finish()} />}
      </div>
    </div>
  )
}

function Welcome({ onNext }: { onNext: () => void }) {
  return (
    <>
      <div className="col" style={{ gap: 'var(--space-3)' }}>
        <h1 className="onboarding__title">{t('Spyly помнит разговоры за вас')}</h1>
        <p className="onboarding__lead">{t('Запишет разговор в Телемосте, Zoom или Meet, расшифрует его с разбивкой по участникам, соберёт конспект с задачами — и отдаст всё это в Claude Desktop, Claude Code или Codex, чтобы обсуждённое сразу превращалось в работу.')}</p>
      </div>
      <div className="col" style={{ gap: 'var(--space-2)' }}>
        <Bullet icon={<IconMic />} title={t('Пишет вас и собеседников раздельно')} hint={t('Поэтому в расшифровке видно, кто что сказал')} />
        <Bullet icon={<IconUsers />} title={t('Узнаёт постоянных участников')} hint={t('Имена подставляются сами со второй встречи')} />
        <Bullet icon={<IconSparkle />} title={t('Работает офлайн')} hint={t('Расшифровка и конспект могут не покидать компьютер')} />
      </div>
      <div className="onboarding__actions">
        <Button variant="primary" size="lg" onClick={onNext}>{t('Начать настройку')}</Button>
      </div>
    </>
  )
}

function Bullet({ icon, title, hint }: { icon: ReactNode; title: string; hint: string }) {
  return (
    <div className="check">
      <span className="check__icon">{icon}</span>
      <div className="check__body">
        <div className="check__title">{title}</div>
        <div className="check__hint">{hint}</div>
      </div>
    </div>
  )
}

function PermissionsStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const [permissions, setPermissions] = useState<Permissions | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = async () => setPermissions(await api.call('app:permissions'))

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 2000)
    return () => clearInterval(timer)
  }, [])

  const request = async (which: 'microphone' | 'systemAudio') => {
    setBusy(which)
    try {
      setPermissions(await api.call('app:requestPermission', which))
    } finally {
      setBusy(null)
    }
  }

  const micOk = permissions?.microphone === 'granted'
  const sysOk = permissions?.systemAudio === 'granted'

  return (
    <>
      <div className="col" style={{ gap: 'var(--space-3)' }}>
        <h1 className="onboarding__title">{t('Доступ к звуку')}</h1>
        <p className="onboarding__lead">{t('Нужны два разрешения: на микрофон — чтобы записать вас, и на системный звук — чтобы записать собеседников.')}</p>
      </div>

      <div className="col" style={{ gap: 'var(--space-2)' }}>
        <PermissionRow
          icon={<IconMic />}
          title={t('Микрофон')}
          granted={micOk}
          busy={busy === 'microphone'}
          hint={t('Ваш голос в записи')}
          onRequest={() => void request('microphone')}
          onOpenSettings={() => void api.call('app:openPrivacySettings', 'microphone')}
        />
        <PermissionRow
          icon={<IconSpeaker />}
          title={t('Системный звук')}
          granted={sysOk}
          busy={busy === 'systemAudio'}
          hint={t('Голоса собеседников из приложения для звонков')}
          onRequest={() => void request('systemAudio')}
          onOpenSettings={() => void api.call('app:openPrivacySettings', 'systemAudio')}
        />
      </div>

      {!sysOk && permissions && (
        <p className="check__hint">{t('Если системный диалог не появился, откройте «Конфиденциальность и безопасность» → «Запись экрана и системного звука» и добавьте Spyly в раздел «Только запись системного звука».')}</p>
      )}

      <div className="onboarding__actions">
        <Button onClick={onBack}>{t('Назад')}</Button>
        <Button variant="primary" onClick={onNext} disabled={!micOk && !sysOk}>{t('Дальше')}</Button>
      </div>
    </>
  )
}

function PermissionRow({
  icon,
  title,
  hint,
  granted,
  busy,
  onRequest,
  onOpenSettings
}: {
  icon: ReactNode
  title: string
  hint: string
  granted: boolean
  busy: boolean
  onRequest: () => void
  onOpenSettings: () => void
}) {
  return (
    <div className="check">
      <span className="check__icon" style={{ color: granted ? 'var(--ds-green-900)' : undefined }}>
        {granted ? <IconCheck /> : icon}
      </span>
      <div className="check__body">
        <div className="spread">
          <div>
            <div className="check__title">{title}</div>
            <div className="check__hint">{granted ? t('Разрешено') : hint}</div>
          </div>
          {!granted && (
            <div className="row" style={{ gap: 'var(--space-2)' }}>
              <Button size="sm" variant="ghost" onClick={onOpenSettings}>{t('Настройки')}</Button>
              <Button size="sm" onClick={onRequest} disabled={busy}>
                {busy ? t('Запрашиваю…') : t('Разрешить')}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function SoundCheck({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const [levels, setLevels] = useState({ mic: 0, system: 0 })
  const [peak, setPeak] = useState({ mic: 0, system: 0 })

  useIpcEvent('audio:levels', (next) => {
    setLevels(next)
    setPeak((prev) => ({ mic: Math.max(prev.mic, next.mic), system: Math.max(prev.system, next.system) }))
  })

  useEffect(() => {
    void api.call('audio:startProbe', {})
    return () => {
      void api.call('audio:stopProbe')
    }
  }, [])

  const micHeard = peak.mic > 0.004
  const sysHeard = peak.system > 0.004

  return (
    <>
      <div className="col" style={{ gap: 'var(--space-3)' }}>
        <h1 className="onboarding__title">{t('Проверим звук')}</h1>
        <p className="onboarding__lead">{t('Скажите что-нибудь вслух и включите любое видео или музыку. Обе полоски должны ожить — иначе запись получится пустой.')}</p>
      </div>

      <div className="col" style={{ gap: 'var(--space-3)' }}>
        <CheckLine title={t('Микрофон')} heard={micHeard} level={levels.mic} hint={t('Скажите что-нибудь')} />
        <CheckLine title={t('Системный звук')} heard={sysHeard} level={levels.system} hint={t('Включите видео или музыку')} />
      </div>

      <div className="onboarding__actions">
        <Button onClick={onBack}>{t('Назад')}</Button>
        <Button variant="primary" onClick={onNext}>
          {micHeard || sysHeard ? t('Дальше') : t('Пропустить проверку')}
        </Button>
      </div>
    </>
  )
}

function CheckLine({ title, heard, level, hint }: { title: string; heard: boolean; level: number; hint: string }) {
  return (
    <div className="check">
      <span className="check__icon" style={{ color: heard ? 'var(--ds-green-900)' : 'var(--ds-gray-700)' }}>
        {heard ? <IconCheck /> : <IconAlert />}
      </span>
      <div className="check__body">
        <div className="check__title">{title}</div>
        <div style={{ margin: 'var(--space-2) 0 4px' }}>
          <Meter level={level} />
        </div>
        <div className="check__hint">{heard ? t('Звук поступает') : hint}</div>
      </div>
    </div>
  )
}

function ModelsStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const [models, setModels] = useState<ModelInfo[]>([])

  const refresh = async () => setModels(await api.call('models:list'))

  useEffect(() => {
    void refresh()
  }, [])

  useIpcEvent('models:progress', (info) => {
    setModels((prev) => prev.map((m) => (m.id === info.id ? { ...m, ...info } : m)))
    if (info.downloaded) void refresh()
  })

  const required = models.filter((m) => m.purpose !== 'asr' || m.id === 'whisper-large-v3-turbo')
  const allReady = required.every((m) => m.downloaded)
  const totalMb = Math.round(required.filter((m) => !m.downloaded).reduce((sum, m) => sum + m.sizeBytes, 0) / 1e6)

  const downloadAll = () => {
    for (const model of required.filter((m) => !m.downloaded && m.progress === undefined)) {
      void api.call('models:download', model.id)
    }
  }

  return (
    <>
      <div className="col" style={{ gap: 'var(--space-3)' }}>
        <h1 className="onboarding__title">{t('Модели для расшифровки')}</h1>
        <p className="onboarding__lead">{t('Скачиваются один раз и работают офлайн — записи никуда не отправляются. Это займёт несколько минут, а записывать можно уже сейчас.')}</p>
      </div>

      <div className="col" style={{ gap: 'var(--space-2)' }}>
        {required.map((model) => (
          <div key={model.id} className="check">
            <span className="check__icon" style={{ color: model.downloaded ? 'var(--ds-green-900)' : undefined }}>
              {model.downloaded ? <IconCheck /> : model.progress !== undefined ? <Spinner /> : <IconSparkle />}
            </span>
            <div className="check__body">
              <div className="spread">
                <div className="grow">
                  <div className="check__title">{model.name}</div>
                  <div className="check__hint">
                    {model.downloaded
                      ? t('Готова')
                      : model.progress !== undefined
                        ? t('Скачивается… {percent}%', { percent: Math.round(model.progress * 100) })
                        : t('{mb} МБ', { mb: Math.round(model.sizeBytes / 1e6) })}
                  </div>
                </div>
              </div>
              {model.progress !== undefined && !model.downloaded && (
                <div style={{ marginTop: 6 }}>
                  <div className="meter">
                    <div className="meter__fill" style={{ width: `${model.progress * 100}%` }} />
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="onboarding__actions">
        <Button onClick={onBack}>{t('Назад')}</Button>
        {!allReady && (
          <Button onClick={downloadAll}>{t('Скачать всё ({mb} МБ)', { mb: totalMb })}</Button>
        )}
        <Button variant="primary" onClick={onNext}>
          {allReady ? t('Дальше') : t('Скачать потом')}
        </Button>
      </div>
    </>
  )
}

function Done({ onFinish }: { onFinish: () => void }) {
  return (
    <>
      <div className="col" style={{ gap: 'var(--space-3)' }}>
        <h1 className="onboarding__title">{t('Всё готово')}</h1>
        <p className="onboarding__lead">{t('Перед следующим разговором нажмите «Начать запись». После остановки появится расшифровка по участникам и конспект. Claude Code и Codex читают записи сами, через MCP — как подключить, написано в настройках, на вкладке «Агенты».')}</p>
      </div>
      <div className="onboarding__actions">
        <Button variant="primary" size="lg" onClick={onFinish}>{t('Начать пользоваться')}</Button>
      </div>
    </>
  )
}
