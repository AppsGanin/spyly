import type {
  Meeting,
  MeetingMeta,
  PromptTemplate,
  Related,
  Summary,
  VoiceProfile
} from '@spyly/core'

/** Что показывает индикатор уровня и пилюля записи. */
export interface RecordingState {
  status: 'idle' | 'starting' | 'recording' | 'paused' | 'stopping'
  meetingId: string | null
  startedAt: number | null
  /** Секунды чистой записи без учёта пауз. */
  elapsedSec: number
  levels: { mic: number; system: number }
  /** Дорожки, которые реально пишутся: пользователь мог выключить одну. */
  tracks: { mic: boolean; system: boolean }
  error: string | null
}

export interface AudioApp {
  key: string
  name: string
  bundleID: string | null
  pids: number[]
  isPlaying: boolean
}

export interface AudioDevice {
  id: string
  name: string
}

export type PermissionState = 'granted' | 'denied' | 'not-determined' | 'unsupported'

export interface Permissions {
  microphone: PermissionState
  systemAudio: PermissionState
}

export interface StartRecordingOptions {
  /** Встреча из календаря, если запись относится к ней. */
  calendarEventId?: string
  calendarParticipants?: string[]
  /** Дописать к этой записи вместо создания новой. */
  continueMeetingId?: string
  mic: boolean
  system: boolean
  micDeviceId?: string
  /** Пусто — весь системный звук; иначе только эти приложения. */
  systemApps?: string[]
  title?: string
}

export type AgentId = 'claude-desktop' | 'claude-code' | 'codex'

export interface AgentStatus {
  id: AgentId
  name: string
  installed: boolean
  connected: boolean
  hint?: string
}

export interface CalendarEventInfo {
  id: string
  title: string
  startsAt: string
  endsAt: string
  participants: string[]
  isNow: boolean
}

export interface ProviderInfo {
  id: string
  name: string
  kind: 'asr' | 'diarization' | 'llm'
  local: boolean
  /** Готов к работе: модель скачана или ключ введён. */
  ready: boolean
  /** Почему не готов — показывается прямо в настройках. */
  hint?: string
}

export interface Settings {
  language: string
  theme: 'dark' | 'light' | 'system'
  /** Язык интерфейса. Меняется перезагрузкой окна: он влияет на каждую надпись. */
  uiLang: 'ru' | 'en'
  /** Какую модель распознавания использовать; пусто — берём крупнейшую скачанную. */
  asrModel: string
  /** Имена, термины и названия проектов — подсказка распознаванию. */
  vocabulary: string[]
  diarizationProvider: string
  llmProvider: string
  /**
   * Сервис с API как у OpenAI: OpenRouter, Groq, локальный vLLM и подобные.
   * Ключ хранится отдельно и в зашифрованном виде — здесь его нет.
   */
  openAiCompatible: { baseUrl: string; model: string }
  /** Порог тишины, ниже которого дорожка считается пустой. */
  liveTranscription: boolean
  autoSummarize: boolean
  autoDetectCalls: 'off' | 'notify' | 'auto'
  storageDir: string
  promptTemplates: PromptTemplate[]
  onboardingDone: boolean
  /** Записывать системный звук по умолчанию только из выбранных приложений. */
  preferredApps: string[]
}

export interface ModelInfo {
  id: string
  name: string
  sizeBytes: number
  downloaded: boolean
  /** 0..1, пока идёт скачивание. */
  progress?: number
  /** Загрузка остановлена, но скачанное сохранено — можно продолжить. */
  paused?: boolean
  /** Сколько байт уже лежит в недокачанном куске. */
  resumableBytes?: number
  purpose: 'asr' | 'diarization' | 'embedding' | 'vad'
  /** Человеческое название варианта: пользователь выбирает качество, а не файл. */
  tier?: string
  /** Чем вариант отличается на практике. */
  tradeoff?: string
  /** Разумный выбор по умолчанию. */
  recommended?: boolean
}

export interface StageProgress {
  meetingId: string
  stage: string
  state: 'running' | 'done' | 'failed'
  /** 0..1, если этап умеет отчитываться. */
  progress?: number
  message?: string
}

/** Запросы renderer → main. Ответ — то, что справа. */
export interface IpcRequests {
  'app:permissions': () => Permissions
  'app:requestPermission': (which: 'microphone' | 'systemAudio') => Permissions
  'app:openPrivacySettings': (which: 'microphone' | 'systemAudio' | 'calendar') => void
  'app:version': () => { app: string; electron: string; platform: string }
  /** Проверка обновлений по просьбе человека. */
  'app:checkUpdates': () =>
    | { state: 'current'; version: string }
    | { state: 'found'; version: string }
    | { state: 'failed'; hint: string }
  'app:openReleases': () => void

  'calendar:status': () => { supported: boolean; granted: boolean }
  'calendar:request': () => { granted: boolean; needsSettings: boolean }
  /** Событие, к которому вероятнее всего относится начинающаяся запись. */
  'calendar:current': () => CalendarEventInfo | null

  'audio:listMics': () => AudioDevice[]
  'audio:listApps': () => AudioApp[]
  /** Пробный запуск обеих дорожек для экрана «Проверка звука». */
  'audio:startProbe': (opts: { micDeviceId?: string; systemApps?: string[] }) => void
  'audio:stopProbe': () => void

  'rec:start': (opts: StartRecordingOptions) => RecordingState
  'rec:stop': () => { meetingId: string | null }
  'rec:pause': () => RecordingState
  'rec:resume': () => RecordingState
  'rec:state': () => RecordingState
  /** Отметить текущий момент записи как важный. */
  'rec:mark': (note?: string) => { id: string; at: number } | null
  /** Дописать пояснение к уже поставленной отметке. */
  'rec:markNote': (id: string, note: string) => void

  'meetings:list': () => MeetingMeta[]
  'meetings:get': (id: string) => Meeting | null
  'meetings:search': (query: string) => { meeting: MeetingMeta; snippet: string }[]
  'meetings:delete': (id: string) => void
  'meetings:update': (id: string, patch: Partial<MeetingMeta>) => MeetingMeta
  'meetings:renameSpeaker': (id: string, speakerId: string, name: string, remember: boolean) => Meeting
  /**
   * Отмена и возврат правок записи.
   *
   * История живёт в памяти главного процесса и не переживает перезапуск —
   * так же, как в любом редакторе.
   */
  'edit:history': (id: string) => { canUndo: boolean; canRedo: boolean }
  'edit:undo': (id: string) => { meeting: Meeting; label: string } | null
  'edit:redo': (id: string) => { meeting: Meeting; label: string } | null
  'meetings:editUtterance': (
    id: string,
    utteranceId: string,
    text: string
  ) => { meeting: Meeting; terms: string[] }
  /** Пополнение словаря терминов; возвращает получившийся список. */
  'vocab:add': (terms: string[]) => string[]
  /** Разделить реплику в указанном символе. */
  'meetings:splitUtterance': (id: string, utteranceId: string, charIndex: number) => Meeting
  /** Склеить реплику со следующей. */
  'meetings:mergeUtterance': (id: string, utteranceId: string) => Meeting
  /** Приписать реплику другому участнику. */
  'meetings:reassignUtterance': (id: string, utteranceId: string, speakerId: string) => Meeting
  /** Черновая расшифровка, которая была видна во время записи. */
  'meetings:live': (id: string) => { track: 'mic' | 'system'; text: string; start: number; end: number }[]
  /** Записи на ту же тему — по общим словам и участникам. */
  'meetings:related': (id: string) => Related[]
  /** Заглушить промежуток и убрать попавшие в него реплики. */
  'meetings:removeRange': (id: string, from: number, to: number) => { meeting: Meeting; removed: number }
  /** Правка конспекта руками: машина ошибается, и это надо чинить. */
  'meetings:updateSummary': (id: string, summary: Summary) => Meeting
  'meetings:reprocess': (id: string, from: 'transcribing' | 'diarizing' | 'summarizing') => void
  'meetings:audioPath': (id: string, track: 'mic' | 'system' | 'mix') => string | null

  'export:markdown': (id: string) => string
  'export:copyPrompt': (id: string, templateId: string) => string
  'export:revealFolder': (id: string) => void
  'agents:status': () => AgentStatus[]
  'agents:setConnection': (id: AgentId, connect: boolean) => { ok: boolean; message: string }
  'agents:verify': () => { ok: boolean; message: string }

  'settings:get': () => Settings
  'settings:set': (patch: Partial<Settings>) => Settings
  'settings:providers': () => ProviderInfo[]
  /** Ключ доступа: наружу отдаём только факт наличия, не само значение. */
  'settings:hasKey': (id: string) => { present: boolean; encrypted: boolean }
  'settings:setKey': (id: string, value: string) => void

  'models:list': () => ModelInfo[]
  'models:download': (id: string) => void
  'models:pause': (id: string) => void
  'models:cancel': (id: string) => void
  'models:remove': (id: string) => void

  'voices:list': () => VoiceProfile[]
  'voices:delete': (id: string) => void
  /** Готова ли модель слепков: без неё запоминать голос нечем. */
  'voices:ready': () => { ready: boolean; hint?: string }
  'voices:enrollStart': () => void
  'voices:enrollStop': (name: string) => VoiceProfile | null

  /**
   * Звук из renderer — путь для Windows и Linux.
   *
   * Сэмплы идут как ArrayBuffer: копировать их в обычный массив на каждом
   * куске значило бы гонять мусор сорок раз в секунду.
   */
  'capture:samples': (track: 'mic' | 'system', pcm: ArrayBuffer) => void
  'capture:ready': (track: 'mic' | 'system') => void
  'capture:failed': (track: 'mic' | 'system', message: string) => void
}

export interface LiveUtterance {
  id: string
  meetingId: string
  track: 'mic' | 'system'
  text: string
  start: number
  end: number
  /**
   * Фраза договорена.
   *
   * Потоковая модель уточняет текст по ходу речи и присылает одну и ту же
   * фразу много раз с одним `id`: пока `final` не выставлен, показанное ещё
   * может измениться.
   */
  final: boolean
}

/** События main → renderer. */
export interface IpcEvents {
  'live:utterance': LiveUtterance
  'rec:state': RecordingState
  'audio:levels': { mic: number; system: number }
  'meetings:changed': { id: string }
  'stage:progress': StageProgress
  'models:progress': ModelInfo
  'call:detected': { app: string; at: number }
  'toast': { kind: 'info' | 'success' | 'error'; text: string }
  /** Открыть конкретную запись — например, по клику на уведомление. */
  'view:meeting': { id: string }
  /** Просьба к renderer открыть или закрыть поток захвата. */
  'capture:start': { track: 'mic' | 'system'; micDeviceId?: string }
  'capture:stop': { track: 'mic' | 'system' }
  /** Открыть экран без кликов — нужно проверочным прогонам. */
  'debug:view': { kind: 'home' | 'settings' | 'record' | 'meeting'; tab?: string }
}

export type IpcChannel = keyof IpcRequests
export type IpcEventName = keyof IpcEvents
