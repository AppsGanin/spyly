import { t } from '@spyly/core'
import { useEffect, useState, type ReactNode } from 'react'
import type { AgentStatus, ModelInfo, ProviderInfo } from '@shared/ipc'
import type { PromptTemplate, VoiceProfile } from '@spyly/core'
import { api, useAsync, useIpcEvent } from '../lib/api'
import { IconAlert, IconCalendar, IconCheck, IconClose, IconCopy, IconMic, IconPause, IconPencil, IconSparkle, IconTerminal, IconTrash } from '../lib/icons'
import { useStore } from '../lib/store'
import { Button, Field, IconButton, Input, Modal, Select, Spinner, Switch } from '../ui'

type Tab = 'general' | 'transcription' | 'voices' | 'agents'

const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: t('Общее') },
  { id: 'transcription', label: t('Расшифровка') },
  { id: 'voices', label: t('Голоса') },
  { id: 'agents', label: t('Агенты') }
]

/** A "caption on the left, control on the right" row, the basic unit of settings. */
function Row({
  title,
  hint,
  inline,
  children
}: {
  title: string
  hint?: string
  /** A narrow control such as a switch: not split across lines in a narrow window. */
  inline?: boolean
  children: ReactNode
}) {
  return (
    <div className={`settings__row ${inline ? 'settings__row--inline' : ''}`}>
      <div>
        <div style={{ fontWeight: 500 }}>{title}</div>
        {hint && <div className="field__hint">{hint}</div>}
      </div>
      {children}
    </div>
  )
}

export function SettingsScreen({ initialTab }: { initialTab?: string } = {}) {
  const { settings, saveSettings, notify } = useStore()
  const [tab, setTab] = useState<Tab>(
    TABS.some((t) => t.id === initialTab) ? (initialTab as Tab) : 'general'
  )
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [models, setModels] = useState<ModelInfo[]>([])
  const [voices, setVoices] = useState<VoiceProfile[]>([])

  const refresh = async () => {
    const [p, m, v] = await Promise.all([
      api.call('settings:providers'),
      api.call('models:list'),
      api.call('voices:list')
    ])
    setProviders(p)
    setModels(m)
    setVoices(v)
  }

  useEffect(() => {
    void refresh()
  }, [])

  useIpcEvent('models:progress', (info) => {
    setModels((prev) => prev.map((m) => (m.id === info.id ? { ...m, ...info } : m)))
    if (info.downloaded) void refresh()
  })

  if (!settings) return null

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text)
    notify('success', t('Скопировано'))
  }

  return (
    <>
      <div className="main__header">
        <h1>{t('Настройки')}</h1>
      </div>

      <div className="tabs">
        {TABS.map((item) => (
          <button
            key={item.id}
            className={`tab ${tab === item.id ? 'tab--active' : ''}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="main__scroll" style={{ paddingTop: 'var(--space-5)' }}>
        <div className="settings">
          {tab === 'general' && (
            <GeneralTab settings={settings} saveSettings={saveSettings} models={models} />
          )}
          {tab === 'transcription' && (
            <TranscriptionTab settings={settings} saveSettings={saveSettings} models={models} />
          )}
          {tab === 'voices' && <VoicesTab voices={voices} onRefresh={refresh} />}
          {tab === 'agents' && (
            <AgentsTab providers={providers} onRefresh={refresh} onCopy={copy} />
          )}
        </div>
      </div>
    </>
  )
}

// ── general ───────────────────────────────────────────────────────────────

function GeneralTab({
  settings,
  saveSettings,
  models
}: {
  settings: NonNullable<ReturnType<typeof useStore>['settings']>
  saveSettings: ReturnType<typeof useStore>['saveSettings']
  models: ModelInfo[]
}) {
  // Instant text comes from the streaming model. Without it live transcription
  // still works, but shows a phrase whole and only once it is finished, and a
  // second cannot be promised in that case.
  const instant = models.find((m) => m.id === 'nemotron-3.5')?.downloaded ?? false
  return (
    <section className="settings__group">
      <Row title={t('Язык интерфейса')} hint={t('Окно перезагрузится: язык влияет на каждую надпись')}>
        <Select
          value={settings.uiLang}
          onChange={(e) => {
            const next = e.target.value as 'ru' | 'en'
            try {
              localStorage.setItem('spyly.lang', next)
            } catch {
              // Private mode: the language will take effect after a restart.
            }
            void saveSettings({ uiLang: next }).then(() => location.reload())
          }}
        >
          <option value="ru">Русский</option>
          <option value="en">English</option>
        </Select>
      </Row>

      <Row title={t('Тема')}>
        <Select value={settings.theme} onChange={(e) => void saveSettings({ theme: e.target.value as 'dark' })}>
          <option value="dark">{t('Тёмная')}</option>
          <option value="light">{t('Светлая')}</option>
          <option value="system">{t('Как в системе')}</option>
        </Select>
      </Row>

      <Row title={t('Язык разговоров')} hint={t('Подсказка для расшифровки')}>
        <Select value={settings.language} onChange={(e) => void saveSettings({ language: e.target.value })}>
          <option value="ru">{t('Русский')}</option>
          <option value="en">{t('Английский')}</option>
          <option value="auto">{t('Определять автоматически')}</option>
        </Select>
      </Row>

      <Row
        title={t('Показывать текст во время записи')}
        hint={
          instant
            ? t('Слова появляются по ходу речи, с задержкой около секунды')
            : t('Фраза появляется, когда договорена. Чтобы слова шли сразу, скачайте Nemotron Speech 3.5 во вкладке «Расшифровка»')
        }
        inline
      >
        <Switch
          checked={settings.liveTranscription}
          onChange={(next) => void saveSettings({ liveTranscription: next })}
          label={t('Живая расшифровка')}
        />
      </Row>

      <Row title={t('Конспект сразу после записи')} hint={t('Иначе его можно собрать вручную на странице записи')} inline>
        <Switch
          checked={settings.autoSummarize}
          onChange={(next) => void saveSettings({ autoSummarize: next })}
          label={t('Конспект автоматически')}
        />
      </Row>

      <Row
        title={t('Замечать начало разговора')}
        hint={t('Spyly замечает, когда микрофон занимает другое приложение')}
      >
        <Select
          value={settings.autoDetectCalls}
          onChange={(e) => void saveSettings({ autoDetectCalls: e.target.value as 'notify' })}
        >
          <option value="off">{t('Не замечать')}</option>
          <option value="notify">{t('Предлагать записать')}</option>
          <option value="auto">{t('Начинать запись сразу')}</option>
        </Select>
      </Row>

      <CalendarAccess />

      <div className="settings__row settings__row--stack">
        <div className="col" style={{ gap: 'var(--space-2)' }}>
          <div style={{ fontWeight: 500 }}>{t('Горячие клавиши')}</div>
          <div className="field__hint">{t('Первое сочетание работает даже когда окно спрятано за приложением для звонков.')}</div>
          <div className="keys">
            {[
              ['\u2318\u21E7R', t('Начать или остановить запись из любого приложения')],
              ['\u2318M', t('Отметить важное место во время записи')],
              ['\u2318F', t('Поиск по записям')],
              ['\u2318Z', t('Отменить правку записи')],
              ['\u2318\u21E7Z', t('Вернуть отменённое')],
              ['\u2318R', t('Запись, когда окно активно')],
              ['\u2318,', t('Настройки')]
            ].map(([combo, what]) => (
              <div key={combo} className="keys__row">
                <kbd>{combo}</kbd>
                <span className="dim">{what}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="settings__row settings__row--stack">
        <Field label={t('Где лежат записи')}>
          <Input readOnly value={settings.storageDir} className="mono" style={{ fontSize: 'var(--text-sm)' }} />
          <span className="field__hint">{t('Каждая запись — отдельная папка: расшифровка в markdown, конспект и звук.')}</span>
        </Field>
      </div>

      <Updates />
    </section>
  )
}

/**
 * Version and updates.
 *
 * The check also runs by itself every few hours, but a person needs somewhere
 * the version is visible and a check can be made now.
 */
function Updates() {
  const { notify } = useStore()
  const { data: version } = useAsync(() => api.call('app:version'), [])
  const [busy, setBusy] = useState(false)

  const check = async () => {
    setBusy(true)
    try {
      const found = await api.call('app:checkUpdates')
      if (found.state === 'found') notify('success', t('Есть обновление: {found_version}. Скачиваю', { found_version: found.version }))
      else if (found.state === 'current') notify('info', t('У вас последняя версия'))
      else notify('error', t('Не удалось проверить: {found_hint}', { found_hint: found.hint }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Row
      title={t('Версия')}
      hint={version ? `Spyly ${version.app} · Electron ${version.electron} · ${version.platform}` : ' '}
      inline
    >
      <div className="row" style={{ gap: 'var(--space-2)' }}>
        <Button size="sm" onClick={() => void api.call('app:openReleases')}>{t('Все версии')}</Button>
        <Button size="sm" disabled={busy} onClick={() => void check()}>
          {busy ? t('Проверяю…') : t('Проверить обновления')}
        </Button>
      </div>
    </Row>
  )
}

/**
 * Calendar access.
 *
 * Without it a recording is called "Recording, 27 August" and the participants
 * "Speaker 2": finding the conversation you want in an archive like that is
 * impossible.
 */
function CalendarAccess() {
  const { notify } = useStore()
  const [state, setState] = useState<{ supported: boolean; granted: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  /** The system has already refused: the dialog will not be shown again, only settings remain. */
  const [denied, setDenied] = useState(false)

  const refresh = async () => setState(await api.call('calendar:status'))
  useEffect(() => {
    void refresh()
  }, [])

  // Coming back from the system settings, a person expects the application to
  // notice the access granted by itself rather than after a restart.
  useEffect(() => {
    const recheck = () => void refresh()
    window.addEventListener('focus', recheck)
    return () => window.removeEventListener('focus', recheck)
  }, [])

  if (!state?.supported) return null

  const request = async () => {
    setBusy(true)
    try {
      const result = await api.call('calendar:request')
      setDenied(result.needsSettings)
      if (result.granted) {
        notify('success', t('Доступ к календарю разрешён'))
      } else {
        // The system shows its dialog once, and sometimes does not show it at all. So
        // we do not report a refusal but lead straight to where access is granted by
        // hand and for certain.
        notify('info', t('Открываю настройки. Включите Spyly в разделе «Календари»'))
        await api.call('app:openPrivacySettings', 'calendar')
      }
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="check">
      <span className="check__icon" style={{ color: state.granted ? 'var(--ds-green-900)' : undefined }}>
        {state.granted ? <IconCheck /> : <IconCalendar />}
      </span>
      <div className="check__body">
        <div className="spread">
          <div className="grow">
            <div className="check__title">{t('Календарь')}</div>
            <div className="check__hint">
              {state.granted
                ? t('Записи получают название встречи и список участников автоматически')
                : denied
                  ? t('Доступ закрыт. Откройте в настройках раздел «Календари» и включите Spyly')
                  : t('Разрешите доступ, и записи будут называться по встрече из календаря')}
            </div>
          </div>
          {!state.granted &&
            (denied ? (
              <Button size="sm" onClick={() => void api.call('app:openPrivacySettings', 'calendar')}>{t('Открыть настройки')}</Button>
            ) : (
              <Button size="sm" disabled={busy} onClick={() => void request()}>
                {busy ? t('Жду ответа…') : t('Разрешить')}
              </Button>
            ))}
        </div>
      </div>
    </div>
  )
}

// ── transcription ─────────────────────────────────────────────────────────

/** Recognition models, from the fast one to the accurate one. One engine: Whisper. */
const ASR_MODELS = [
  'whisper-large-v3-turbo',
  'whisper-large-v3',
  'gigaam-v3-ru',
  'parakeet-tdt-v3',
  'nemotron-3.5',
  'whisper-medium',
  'whisper-small'
]

function TranscriptionTab({
  settings,
  saveSettings,
  models
}: {
  settings: NonNullable<ReturnType<typeof useStore>['settings']>
  saveSettings: ReturnType<typeof useStore>['saveSettings']
  models: ModelInfo[]
}) {
  const allowed = ASR_MODELS
  // The model list otherwise grows to nine entries all mixed together: only those
  // belonging to the chosen engine are shown, plus the shared ones.
  const visible = models.filter((m) => m.purpose !== 'asr' || allowed.includes(m.id))
  // Whatever the chosen engine is missing is what we offer to download in one click.
  const engineModels = models.filter((m) => allowed.includes(m.id))
  // If no explicit choice was made, or its model was deleted, we show the one the
  // engine will take by itself: the first downloaded one in descending accuracy.
  const downloadedOwn = engineModels.filter((m) => m.downloaded)
  const activeModel =
    downloadedOwn.find((m) => m.id === settings.asrModel)?.id ??
    engineModels.find((m) => m.recommended && m.downloaded)?.id ??
    downloadedOwn[0]?.id ??
    ''

  /**
   * Choosing a variant is one action: what is missing downloads and becomes
   * working straight away rather than needing a second press of "Download".
   */
  const chooseModel = async (model: ModelInfo) => {
    await saveSettings({ asrModel: model.id })
    if (!model.downloaded && model.progress === undefined) {
      void api.call('models:download', model.id)
    }
  }
  const shared = visible.filter((m) => m.purpose !== 'asr')
  const engineOwn = visible.filter((m) => m.purpose === 'asr')

  return (
    <>
      <section className="settings__group">
        <div className="settings__row settings__row--stack">
          <div className="col" style={{ gap: 'var(--space-2)' }}>
            <div style={{ fontWeight: 500 }}>{t('Модель распознавания')}</div>
            <div className="field__hint">{t('Всё считается на этом компьютере, записи никуда не уходят. Выберите модель — если она ещё не загружена, Spyly скачает её и сделает рабочей.')}</div>
            <div className="options" role="radiogroup" aria-label={t('Модель распознавания')}>
              {engineOwn.map((model) => (
                <QualityOption
                  key={model.id}
                  model={model}
                  selected={activeModel === model.id}
                  onSelect={() => void chooseModel(model)}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="settings__row settings__row--stack">
          <div className="col" style={{ gap: 'var(--space-2)' }}>
            <div style={{ fontWeight: 500 }}>{t('Служебные модели')}</div>
            <div className="field__hint">{t('Разделяют речь по голосам и узнают участников по слепку.')}</div>
            {shared.map((model) => (
              <SupportModel key={model.id} model={model} />
            ))}
          </div>
        </div>
      </section>

      <section className="settings__group">
        <div className="settings__groupTitle">{t('Словарь')}</div>
        <VocabularyEditor
          terms={settings.vocabulary}
          onChange={(vocabulary) => void saveSettings({ vocabulary })}
          supported
        />
      </section>
    </>
  )
}

/**
 * Choosing recognition quality.
 *
 * The user is choosing a trade-off between accuracy and speed, not a file:
 * names like `large-v3-turbo` mean nothing to them. Downloading is part of the
 * choice rather than a separate step: press a variant, it downloads and becomes
 * the working one.
 */
function QualityOption({
  model,
  selected,
  onSelect
}: {
  model: ModelInfo
  selected: boolean
  onSelect: () => void
}) {
  const downloading = model.progress !== undefined && !model.downloaded
  const paused = !model.downloaded && !downloading && (model.resumableBytes ?? 0) > 0
  const mb = (bytes: number) => t('{mb} МБ', { mb: Math.round(bytes / 1e6) })

  const status = downloading
    ? t('Скачивается… {percent}%', { percent: Math.round((model.progress ?? 0) * 100) })
    : paused
      ? t('Приостановлено · {done} из {total}', { done: mb(model.resumableBytes ?? 0), total: mb(model.sizeBytes) })
      : model.downloaded
        ? selected
          ? t('Используется')
          : t('Загружена')
        : mb(model.sizeBytes)

  return (
    <div
      className={`option ${selected ? 'option--selected' : ''}`}
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
    >
      <span className={`option__mark ${selected ? 'option__mark--on' : ''}`} aria-hidden="true" />

      <div className="option__body">
        {/* Заголовок — настоящее имя модели: по нему её можно найти и
            сравнить с чужими замерами. Что она даёт на практике — строкой
            ниже, там же, где остальные пояснения. */}
        <div className="option__title">
          {model.name}
          {model.recommended && !selected && <span className="badge badge--blue">{t('рекомендуем')}</span>}
        </div>
        <div className="option__hint">{model.tradeoff ?? model.tier}</div>
        {(downloading || paused) && (
          <div className="meter" style={{ marginTop: 8 }}>
            <div
              className={`meter__fill ${paused ? 'meter__fill--silent' : ''}`}
              style={{
                width: `${
                  (downloading
                    ? (model.progress ?? 0)
                    : (model.resumableBytes ?? 0) / Math.max(1, model.sizeBytes)) * 100
                }%`
              }}
            />
          </div>
        )}
      </div>

      <div className="option__side" onClick={(e) => e.stopPropagation()}>
        <span className="option__status">{status}</span>
        {downloading && (
          <IconButton aria-label={t('Приостановить')} title={t('Приостановить')} onClick={() => void api.call('models:pause', model.id)}>
            <IconPause />
          </IconButton>
        )}
        {paused && (
          <IconButton
            aria-label={t('Отменить загрузку')}
            title={t('Отменить загрузку')}
            onClick={() => void api.call('models:cancel', model.id)}
          >
            <IconClose />
          </IconButton>
        )}
        {model.downloaded && !selected && (
          <IconButton
            aria-label={t('Удалить {what}', { what: model.tier ?? model.name })}
            title={t('Удалить файл модели')}
            onClick={() => void api.call('models:remove', model.id)}
          >
            <IconTrash />
          </IconButton>
        )}
      </div>
    </div>
  )
}

/** Support models: there is nothing to choose, only presence matters. */
function SupportModel({ model }: { model: ModelInfo }) {
  const downloading = model.progress !== undefined && !model.downloaded
  return (
    <div className="support">
      <span className="support__icon" style={{ color: model.downloaded ? 'var(--ds-green-900)' : undefined }}>
        {model.downloaded ? <IconCheck /> : downloading ? <Spinner /> : <IconAlert />}
      </span>
      <span className="grow">{model.name}</span>
      <span className="dim">
        {downloading
          ? `${Math.round((model.progress ?? 0) * 100)}%`
          : t('{mb} МБ', { mb: Math.round(model.sizeBytes / 1e6) })}
      </span>
      {!model.downloaded && !downloading && (
        <Button size="sm" onClick={() => void api.call('models:download', model.id)}>{t('Скачать')}</Button>
      )}
    </div>
  )
}

/**
 * A dictionary of names and terms.
 *
 * Recognition does not know that "billing" is billing rather than "Belling"
 * until it sees the word in context. The list is passed as a hint to every
 * transcription; the names of remembered participants are added to it
 * automatically.
 */
function VocabularyEditor({
  terms,
  onChange,
  supported
}: {
  terms: string[]
  onChange: (next: string[]) => void
  /** Not every engine accepts a hint. */
  supported: boolean
}) {
  const [draft, setDraft] = useState('')

  const add = () => {
    const parts = draft
      .split(/[,\n]/)
      .map((t) => t.trim())
      .filter(Boolean)
      .filter((t) => !terms.some((existing) => existing.toLowerCase() === t.toLowerCase()))
    if (parts.length === 0) return
    onChange([...terms, ...parts])
    setDraft('')
  }

  return (
    <div className="col" style={{ gap: 'var(--space-3)' }}>
      <p className="field__hint">{t('Имена коллег, названия проектов, профессиональный жаргон — всё, что распознавание может расслышать неправильно. Имена участников из вкладки «Голоса» добавляются сами.')}</p>

      {!supported && (
        <div className="check">
          <span className="check__icon" style={{ color: 'var(--ds-amber-900)' }}><IconAlert /></span>
          <div className="check__body">
            <div className="check__title">{t('Выбранный движок подсказку не принимает')}</div>
            <div className="check__hint">{t('Словарь работает только с Whisper. Список сохранится и заработает, если вернуть эту модель.')}</div>
          </div>
        </div>
      )}

      <div className="row" style={{ gap: 'var(--space-2)' }}>
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t('Например: биллинг, Кафка, Мария Петрова')}
          aria-label={t('Новый термин')}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
        />
        <Button onClick={add} disabled={!draft.trim()}>{t('Добавить')}</Button>
      </div>

      {terms.length > 0 && (
        <div className="chips">
          {terms.map((term) => (
            <span key={term} className="chip">
              {term}
              <button
                className="chip__remove"
                aria-label={t('Убрать {term}', { term: term })}
                onClick={() => onChange(terms.filter((t) => t !== term))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * What to install so that summaries are made automatically.
 *
 * API keys have been taken out of the application, so every option here comes
 * without a per-token bill: a coding agent already authorised, or a local
 * model. With nothing installed a summary can still be had by asking Claude
 * Desktop for one, which already sees the recordings over MCP.
 */
function SummarySetup({ onCopy }: { onCopy: (text: string) => void }) {
  const options = [
    {
      name: 'Claude Code',
      hint: t('работает по вашей подписке Claude, ключ не нужен'),
      command: 'npm install -g @anthropic-ai/claude-code'
    },
    {
      name: 'Codex',
      hint: t('работает по вашей подписке OpenAI'),
      command: 'npm install -g @openai/codex'
    },
    {
      name: 'Ollama',
      hint: t('полностью локально, без аккаунта'),
      command: 'brew install ollama && ollama pull qwen3'
    }
  ]

  return (
    <div className="col" style={{ gap: 'var(--space-2)' }}>
      <div style={{ fontWeight: 500 }}>{t('Конспект пока некому собирать')}</div>
      <p className="field__hint">{t('Нужна языковая модель. Поставьте любую из перечисленных: API-ключ и оплата по токенам не понадобятся. После установки перезапустите Spyly.')}</p>
      {options.map((option) => (
        <div key={option.name} className="check">
          <span className="check__icon">
            <IconTerminal />
          </span>
          <div className="check__body">
            <div className="check__title">{option.name}</div>
            <div className="check__hint">{option.hint}</div>
            <div className="row" style={{ gap: 'var(--space-2)', marginTop: 6 }}>
              <Input readOnly value={option.command} className="mono" style={{ fontSize: 'var(--text-sm)' }} />
              <IconButton aria-label={t('Скопировать команду')} onClick={() => onCopy(option.command)}>
                <IconCopy />
              </IconButton>
            </div>
          </div>
        </div>
      ))}
      <p className="field__hint">{t('Можно и без этого: подключите Claude Desktop на вкладке «Агенты» и просите конспект прямо у него — записи ему уже видны.')}</p>
    </div>
  )
}

/**
 * A custom service with an API like OpenAI's.
 *
 * This is how OpenRouter, Groq and a local vLLM connect, along with anything
 * else speaking the same protocol. A section of its own rather than a line in
 * the model list: there is something to enter here, and something to warn about.
 */
function OpenAiCompatible({
  settings,
  saveSettings,
  onRefresh
}: {
  settings: NonNullable<ReturnType<typeof useStore>['settings']>
  saveSettings: ReturnType<typeof useStore>['saveSettings']
  onRefresh: () => Promise<void>
}) {
  const { notify } = useStore()
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState('')
  const [state, setState] = useState<{ present: boolean; encrypted: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  const config = settings.openAiCompatible

  const refresh = async () => setState(await api.call('settings:hasKey', 'openai-compatible.key'))
  useEffect(() => {
    void refresh()
  }, [])

  const save = async () => {
    setBusy(true)
    try {
      // The key is written only if one was entered: an empty field means "leave as it
      // was" rather than "erase", and erasing has a button of its own.
      if (key.trim()) await api.call('settings:setKey', 'openai-compatible.key', key.trim())
      setKey('')
      await refresh()
      await onRefresh()

      // A service is configured in order to be used: it is selected straight away,
      // or nothing visibly changes after saving.
      const ready = (await api.call('settings:providers')).find((p) => p.id === 'openai-compatible')
      if (ready?.ready) {
        await saveSettings({ llmProvider: 'openai-compatible' })
        notify('success', t('Сервис подключён'))
      } else {
        notify('info', ready?.hint ? t('Сохранено, но пока не работает: {ready_hint}', { ready_hint: ready.hint }) : t('Сохранено'))
      }
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  const forget = async () => {
    await api.call('settings:setKey', 'openai-compatible.key', '')
    await refresh()
    await onRefresh()
    notify('info', t('Ключ удалён'))
  }

  const configured = Boolean(config.baseUrl && config.model && state?.present)

  return (
    <>
      <div className="check" style={{ marginTop: 'var(--space-3)' }}>
        <span className="check__icon" style={{ color: configured ? 'var(--ds-green-900)' : undefined }}>
          {configured ? <IconCheck /> : <IconSparkle />}
        </span>
        <div className="check__body">
          <div className="spread">
            <div className="grow">
              <div className="check__title">{t('Свой сервис (OpenAI-совместимый)')}</div>
              <div className="check__hint">
                {configured
                  ? t('{model} через {url}', { model: config.model, url: config.baseUrl })
                  : t('OpenRouter, Groq, vLLM и всё остальное с тем же API')}
              </div>
            </div>
            <Button size="sm" onClick={() => setOpen(true)}>
              {configured ? t('Изменить') : t('Подключить')}
            </Button>
          </div>
        </div>
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t('Свой сервис для конспекта')}
        actions={
          <>
            {state?.present && (
              <Button variant="danger" onClick={() => void forget()}>{t('Удалить ключ')}</Button>
            )}
            <Button onClick={() => setOpen(false)}>{t('Отмена')}</Button>
            <Button variant="primary" disabled={busy} onClick={() => void save()}>
              {busy ? t('Сохраняю…') : t('Сохранить')}
            </Button>
          </>
        }
      >
        <Field
          label={t('Адрес')}
          hint={t('Например https://openrouter.ai/api/v1. Путь /v1 можно не писать')}
        >
          <Input
            value={config.baseUrl}
            placeholder="https://openrouter.ai/api/v1"
            onChange={(e) =>
              void saveSettings({ openAiCompatible: { ...config, baseUrl: e.target.value } })
            }
          />
        </Field>

        <Field label={t('Модель')} hint={t('Название модели у вашего сервиса')}>
          <Input
            value={config.model}
            placeholder="anthropic/claude-sonnet-4"
            onChange={(e) => void saveSettings({ openAiCompatible: { ...config, model: e.target.value } })}
          />
        </Field>

        <Field
          label={t('Ключ')}
          hint={
            state?.present
              ? t('Ключ уже сохранён. Введите новый, чтобы заменить, или оставьте поле пустым')
              : state?.encrypted === false
                ? t('Ключ будет лежать на диске открытым текстом: система не дала шифрование')
                : t('Хранится в системной ключнице, в настройках его не видно')
          }
        >
          <Input
            type="password"
            value={key}
            placeholder={state?.present ? '••••••••' : 'sk-...'}
            autoComplete="off"
            onChange={(e) => setKey(e.target.value)}
          />
        </Field>
      </Modal>
    </>
  )
}

// ── voices ────────────────────────────────────────────────────────────────

function VoicesTab({ voices, onRefresh }: { voices: VoiceProfile[]; onRefresh: () => Promise<void> }) {
  const [ready, setReady] = useState<{ ready: boolean; hint?: string } | null>(null)

  useEffect(() => {
    void api.call('voices:ready').then(setReady)
  }, [])

  return (
    <section className="settings__group">
      <p className="field__hint">{t('Слепки голоса нужны, чтобы имена подставлялись сами. Это биометрия: она хранится только здесь и никуда не отправляется.')}</p>

      <VoiceEnroll
        onDone={onRefresh}
        hasMine={voices.some((v) => v.isMe)}
        blockedReason={ready && !ready.ready ? (ready.hint ?? t('модель слепков не готова')) : null}
      />

      {voices.length === 0 ? (
        <p className="dim">{t('Пока никого не запомнили. Свой голос можно записать кнопкой выше, чужие — на странице встречи: нажмите на имя участника и поставьте галочку «Запомнить голос».')}</p>
      ) : (
        <div className="col" style={{ gap: 'var(--space-1)' }}>
          {voices.map((voice) => (
            <div key={voice.id} className="appitem">
              <span className="grow">
                {voice.name}
                <span
                  className="dim"
                  title={t('Чем больше записей голоса, тем увереннее узнавание: слепки усредняются')}
                >
                  {' '}
                  {t('· записей голоса: {n}', { n: voice.samples })}
                </span>
              </span>
              <IconButton
                aria-label={t('Забыть {voice_name}', { voice_name: voice.name })}
                onClick={() => void api.call('voices:delete', voice.id).then(onRefresh)}
              >
                <IconTrash />
              </IconButton>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * Recording your own voice print.
 *
 * Without it the transcript cannot tell the owner from other people in the
 * room: both microphone tracks look the same.
 */
function VoiceEnroll({
  onDone,
  hasMine,
  blockedReason
}: {
  onDone: () => Promise<void>
  hasMine: boolean
  /** Why a voice cannot be recorded right now. */
  blockedReason: string | null
}) {
  const { notify } = useStore()
  const [name, setName] = useState('')
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    if (!recording) return
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(timer)
  }, [recording])

  const start = async () => {
    setSeconds(0)
    setRecording(true)
    await api.call('voices:enrollStart')
  }

  const stop = async () => {
    setRecording(false)
    const profile = await api.call('voices:enrollStop', name.trim() || t('Вы'))
    if (profile) {
      notify('success', t('Голос запомнен: {profile_name}', { profile_name: profile.name }))
      setName('')
      await onDone()
    } else {
      notify('error', t('Слишком короткая запись: говорите хотя бы несколько секунд'))
    }
  }

  return (
    <div className="check">
      <span className="check__icon">{recording ? <Spinner /> : <IconMic />}</span>
      <div className="check__body">
        <div className="spread">
          <div className="grow">
            <div className="check__title">
              {recording ? t('Говорите… {seconds} с', { seconds: seconds }) : hasMine ? t('Перезаписать свой голос') : t('Записать свой голос')}
            </div>
            <div className="check__hint" style={blockedReason ? { color: 'var(--ds-amber-900)' } : undefined}>
              {blockedReason
                ? blockedReason
                : recording
                  ? t('Расскажите что-нибудь обычным голосом, секунд пятнадцать')
                  : t('Тогда в расшифровках вы будете отмечены отдельно от других людей в комнате')}
            </div>
          </div>
          <div className="row" style={{ gap: 'var(--space-2)' }}>
            {!recording && (
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('Вы')}
                style={{ width: 130 }}
                aria-label={t('Как подписывать')}
              />
            )}
            <Button
              size="sm"
              variant={recording ? 'danger' : 'default'}
              disabled={Boolean(blockedReason)}
              onClick={() => void (recording ? stop() : start())}
            >
              {recording ? t('Готово') : t('Записать')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── agents ────────────────────────────────────────────────────────────────

/**
 * Connecting to agents with a button.
 *
 * This used to be commands to copy into a terminal, but someone who records
 * conversations should not have to go digging through config files. Each agent
 * keeps its MCP settings its own way, so the application edits them itself.
 */
function AgentsTab({
  providers,
  onRefresh,
  onCopy
}: {
  providers: ProviderInfo[]
  onRefresh: () => Promise<void>
  onCopy: (text: string) => void
}) {
  const { notify, settings, saveSettings } = useStore()
  const readyLlm = providers.filter((p) => p.kind === 'llm' && p.ready)
  const [agents, setAgents] = useState<AgentStatus[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [verdict, setVerdict] = useState<string | null>(null)

  const check = async () => {
    setChecking(true)
    setVerdict(null)
    try {
      const result = await api.call('agents:verify')
      setVerdict(result.message)
      notify(result.ok ? 'success' : 'error', result.message)
    } finally {
      setChecking(false)
    }
  }

  const [loading, setLoading] = useState(true)
  const refresh = async () => {
    try {
      setAgents(await api.call('agents:status'))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void refresh()
  }, [])

  const toggle = async (agent: AgentStatus) => {
    setBusy(agent.id)
    try {
      const result = await api.call('agents:setConnection', agent.id, !agent.connected)
      notify(result.ok ? 'success' : 'error', result.message)
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <section className="settings__group">
        <div className="settings__groupTitle">{t('Конспект')}</div>
        {readyLlm.length > 0 ? (
          <Row
            title={t('Чем собирать')}
            hint={t('В списке только готовое к работе: свой сервис появится, когда вы его настроите')}
          >
            <Select
              value={
                readyLlm.some((p) => p.id === settings?.llmProvider)
                  ? settings!.llmProvider
                  : readyLlm[0]!.id
              }
              onChange={(e) => void saveSettings({ llmProvider: e.target.value })}
            >
              {readyLlm.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </Select>
          </Row>
        ) : (
          <SummarySetup onCopy={onCopy} />
        )}

        {settings && (
          <OpenAiCompatible settings={settings} saveSettings={saveSettings} onRefresh={onRefresh} />
        )}
      </section>

    <section className="settings__group">
      <p className="field__hint">{t('После подключения агент сам сможет искать по вашим записям — например, на вопрос «что мы решили про биллинг во вторник». Расшифровки при этом остаются на диске: агент читает их по запросу, никуда не выгружая.')}</p>

      {/* Поиск установленных агентов занимает до секунды: пустой список без
          объяснения выглядит как «ничего не нашлось». */}
      {loading && agents.length === 0 && (
        <div className="check">
          <span className="check__icon"><Spinner /></span>
          <div className="check__body">
            <div className="check__title">{t('Ищу установленных агентов…')}</div>
          </div>
        </div>
      )}

      {agents.map((agent) => (
        <div key={agent.id} className="check">
          <span className="check__icon" style={{ color: agent.connected ? 'var(--ds-green-900)' : undefined }}>
            {agent.connected ? <IconCheck /> : <IconTerminal />}
          </span>
          <div className="check__body">
            <div className="spread">
              <div className="grow">
                <div className="check__title">{agent.name}</div>
                <div className="check__hint">
                  {!agent.installed
                    ? (agent.hint ?? t('не найден на этом компьютере'))
                    : agent.connected
                      ? t('Подключено. Спросите агента про любую свою запись')
                      : t('Пропишем Spyly в его настройки одним нажатием')}
                </div>
              </div>
              <Button
                size="sm"
                onClick={() => void toggle(agent)}
                disabled={busy === agent.id || !agent.installed}
              >
                {busy === agent.id ? t('Минуту…') : agent.connected ? t('Отключить') : t('Подключить')}
              </Button>
            </div>
          </div>
        </div>
      ))}

      <div className="check">
        <span className="check__icon"><IconSparkle /></span>
        <div className="check__body">
          <div className="spread">
            <div className="grow">
              <div className="check__title">{t('Проверить сервер')}</div>
              <div className="check__hint">
                {verdict ?? t('Запустит сервер так же, как это делает агент, и проверит ответ')}
              </div>
            </div>
            <Button size="sm" disabled={checking} onClick={() => void check()}>
              {checking ? t('Проверяю…') : t('Проверить')}
            </Button>
          </div>
        </div>
      </div>

      <p className="field__hint">{t('После подключения перезапустите агента: настройки он читает при старте.')}</p>

      <PromptTemplates />
    </section>
    </>
  )
}


/**
 * Your own wording of the task for an agent.
 *
 * The four ready-made ones cover the usual cases, but everyone's work is
 * different: one person needs tickets in their tracker, another a letter to a
 * client. Letting the text be rewritten is easier than guessing.
 */

function PromptTemplates() {
  const { settings, saveSettings, notify } = useStore()
  const [editing, setEditing] = useState<PromptTemplate | null>(null)
  const templates = settings?.promptTemplates ?? []

  const save = async (next: PromptTemplate[]) => {
    await saveSettings({ promptTemplates: next })
  }

  const commit = async () => {
    if (!editing) return
    const name = editing.name.trim()
    const instruction = editing.instruction.trim()
    if (!name || !instruction) {
      notify('error', t('Название и текст не должны быть пустыми'))
      return
    }
    const clean = { ...editing, name, instruction }
    const exists = templates.some((t) => t.id === clean.id)
    await save(exists ? templates.map((t) => (t.id === clean.id ? clean : t)) : [...templates, clean])
    setEditing(null)
  }

  const remove = async (id: string) => {
    // The last template cannot be deleted: without one the "Hand to an agent"
    // button would have nothing to work with.
    if (templates.length <= 1) {
      notify('error', t('Нужен хотя бы один шаблон'))
      return
    }
    await save(templates.filter((t) => t.id !== id))
  }

  return (
    <>
      <div className="settings__row settings__row--inline" style={{ marginTop: 'var(--space-4)' }}>
        <div>
          <div style={{ fontWeight: 500 }}>{t('Шаблоны промпта')}</div>
          <div className="field__hint">{t('С этим текстом запись уходит агенту')}</div>
        </div>
        <Button
          size="sm"
          onClick={() => setEditing({ id: `custom-${Date.now().toString(36)}`, name: '', instruction: '' })}
        >{t('Добавить')}</Button>
      </div>

      <div className="tmpl-list">
        {templates.map((template) => (
          <div key={template.id} className="tmpl">
            <div className="grow">
              <div className="check__title">{template.name}</div>
              <div className="check__hint tmpl__text">{template.instruction}</div>
            </div>
            <div className="row" style={{ gap: 'var(--space-1)' }}>
              <IconButton aria-label={t('Изменить')} title={t('Изменить')} onClick={() => setEditing({ ...template })}>
                <IconPencil />
              </IconButton>
              <IconButton
                aria-label={t('Удалить')}
                title={templates.length <= 1 ? t('Нужен хотя бы один шаблон') : t('Удалить')}
                disabled={templates.length <= 1}
                onClick={() => void remove(template.id)}
              >
                <IconTrash />
              </IconButton>
            </div>
          </div>
        ))}
      </div>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={templates.some((t) => t.id === editing?.id) ? t('Изменить шаблон') : t('Новый шаблон')}
        actions={
          <>
            <Button onClick={() => setEditing(null)}>{t('Отмена')}</Button>
            <Button variant="primary" onClick={() => void commit()}>{t('Сохранить')}</Button>
          </>
        }
      >
        {editing && (
          <>
            <Field label={t('Название')} hint={t('Так шаблон будет называться в списке промптов')}>
              <Input
                value={editing.name}
                autoFocus
                placeholder={t('Например: тикеты в трекер')}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </Field>

            <Field label={t('Текст')} hint={t('Расшифровка подставится следом, писать про неё не нужно')}>
              <textarea
                className="input textarea"
                rows={7}
                value={editing.instruction}
                placeholder={t('Ниже расшифровка разговора. Собери из неё…')}
                onChange={(e) => setEditing({ ...editing, instruction: e.target.value })}
              />
            </Field>
          </>
        )}
      </Modal>
    </>
  )
}
