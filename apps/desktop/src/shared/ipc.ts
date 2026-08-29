import type {
  Meeting,
  MeetingMeta,
  PromptTemplate,
  Related,
  Summary,
  VoiceProfile
} from '@spyly/core'

/** What the level meter and the recording pill show. */
export interface RecordingState {
  status: 'idle' | 'starting' | 'recording' | 'paused' | 'stopping'
  meetingId: string | null
  startedAt: number | null
  /** Seconds of actual recording, pauses excluded. */
  elapsedSec: number
  levels: { mic: number; system: number }
  /** The tracks that are really being written: the user may have switched one off. */
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
  /** The calendar meeting, if the recording belongs to one. */
  calendarEventId?: string
  calendarParticipants?: string[]
  /** Append to this recording instead of creating a new one. */
  continueMeetingId?: string
  mic: boolean
  system: boolean
  micDeviceId?: string
  /** Empty means all system audio; otherwise only these applications. */
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
  /** Ready to work: the model downloaded or the key entered. */
  ready: boolean
  /** Why it is not ready, shown right in the settings. */
  hint?: string
}

export interface Settings {
  language: string
  theme: 'dark' | 'light' | 'system'
  /** The interface language. Changed by reloading the window: it affects every caption. */
  uiLang: 'ru' | 'en'
  /** Which recognition model to use; empty means the largest one downloaded. */
  asrModel: string
  /** Names, terms and project names, a hint for recognition. */
  vocabulary: string[]
  diarizationProvider: string
  llmProvider: string
  /**
   * A service with an API like OpenAI's: OpenRouter, Groq, a local vLLM and the
   * like. The key is stored separately and encrypted, so it is not here.
   */
  openAiCompatible: { baseUrl: string; model: string }
  /** The silence threshold below which a track counts as empty. */
  liveTranscription: boolean
  autoSummarize: boolean
  autoDetectCalls: 'off' | 'notify' | 'auto'
  storageDir: string
  promptTemplates: PromptTemplate[]
  onboardingDone: boolean
  /** Record system audio from the chosen applications only, by default. */
  preferredApps: string[]
}

export interface ModelInfo {
  id: string
  name: string
  sizeBytes: number
  downloaded: boolean
  /** 0..1 while the download runs. */
  progress?: number
  /** The download is stopped but what was downloaded is kept, so it can be resumed. */
  paused?: boolean
  /** How many bytes are already in the partial file. */
  resumableBytes?: number
  purpose: 'asr' | 'diarization' | 'embedding' | 'vad'
  /** A human name for the variant: the user chooses quality, not a file. */
  tier?: string
  /** What the variant does differently in practice. */
  tradeoff?: string
  /** A sensible default. */
  recommended?: boolean
}

export interface StageProgress {
  meetingId: string
  stage: string
  state: 'running' | 'done' | 'failed'
  /** 0..1, if the stage can report progress. */
  progress?: number
  message?: string
}

/** Requests from the renderer to main. The answer is what stands on the right. */
export interface IpcRequests {
  'app:permissions': () => Permissions
  'app:requestPermission': (which: 'microphone' | 'systemAudio') => Permissions
  'app:openPrivacySettings': (which: 'microphone' | 'systemAudio' | 'calendar') => void
  'app:version': () => { app: string; electron: string; platform: string }
  /** Checking for updates at a person's request. */
  'app:checkUpdates': () =>
    | { state: 'current'; version: string }
    | { state: 'found'; version: string }
    | { state: 'failed'; hint: string }
  'app:openReleases': () => void

  'calendar:status': () => { supported: boolean; granted: boolean }
  'calendar:request': () => { granted: boolean; needsSettings: boolean }
  /** The event a starting recording most likely belongs to. */
  'calendar:current': () => CalendarEventInfo | null

  'audio:listMics': () => AudioDevice[]
  'audio:listApps': () => AudioApp[]
  /** A trial run of both tracks for the "Sound check" screen. */
  'audio:startProbe': (opts: { micDeviceId?: string; systemApps?: string[] }) => void
  'audio:stopProbe': () => void

  'rec:start': (opts: StartRecordingOptions) => RecordingState
  'rec:stop': () => { meetingId: string | null }
  'rec:pause': () => RecordingState
  'rec:resume': () => RecordingState
  'rec:state': () => RecordingState
  /** Mark the current moment of the recording as important. */
  'rec:mark': (note?: string) => { id: string; at: number } | null
  /** Add a note to a mark that has already been placed. */
  'rec:markNote': (id: string, note: string) => void

  'meetings:list': () => MeetingMeta[]
  'meetings:get': (id: string) => Meeting | null
  'meetings:search': (query: string) => { meeting: MeetingMeta; snippet: string }[]
  'meetings:delete': (id: string) => void
  'meetings:update': (id: string, patch: Partial<MeetingMeta>) => MeetingMeta
  'meetings:renameSpeaker': (id: string, speakerId: string, name: string, remember: boolean) => Meeting
  /**
   * Undo and redo of edits to a recording.
   *
   * History lives in the main process's memory and does not survive a restart,
   * the same as in any editor.
   */
  'edit:history': (id: string) => { canUndo: boolean; canRedo: boolean }
  'edit:undo': (id: string) => { meeting: Meeting; label: string } | null
  'edit:redo': (id: string) => { meeting: Meeting; label: string } | null
  'meetings:editUtterance': (
    id: string,
    utteranceId: string,
    text: string
  ) => { meeting: Meeting; terms: string[] }
  /** Adding to the term dictionary; returns the resulting list. */
  'vocab:add': (terms: string[]) => string[]
  /** Split an utterance at the given character. */
  'meetings:splitUtterance': (id: string, utteranceId: string, charIndex: number) => Meeting
  /** Join an utterance with the next one. */
  'meetings:mergeUtterance': (id: string, utteranceId: string) => Meeting
  /** Reassign an utterance to another participant. */
  'meetings:reassignUtterance': (id: string, utteranceId: string, speakerId: string) => Meeting
  /** The draft transcript that was visible during the recording. */
  'meetings:live': (id: string) => { track: 'mic' | 'system'; text: string; start: number; end: number }[]
  /** Recordings on the same subject, by shared words and participants. */
  'meetings:related': (id: string) => Related[]
  /** Silence a stretch and remove the utterances that fall inside it. */
  'meetings:removeRange': (id: string, from: number, to: number) => { meeting: Meeting; removed: number }
  /** Editing the summary by hand: the machine makes mistakes, and they have to be fixable. */
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
  /** An API key: only the fact that one exists is handed out, never the value. */
  'settings:hasKey': (id: string) => { present: boolean; encrypted: boolean }
  'settings:setKey': (id: string, value: string) => void

  'models:list': () => ModelInfo[]
  'models:download': (id: string) => void
  'models:pause': (id: string) => void
  'models:cancel': (id: string) => void
  'models:remove': (id: string) => void

  'voices:list': () => VoiceProfile[]
  'voices:delete': (id: string) => void
  /** Whether the print model is ready: without it there is nothing to remember a voice with. */
  'voices:ready': () => { ready: boolean; hint?: string }
  'voices:enrollStart': () => void
  'voices:enrollStop': (name: string) => VoiceProfile | null

  /**
   * Audio from the renderer, the path for Windows and Linux.
   *
   * The samples come as an ArrayBuffer: copying them into an ordinary array on
   * every chunk would mean churning garbage forty times a second.
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
   * The phrase is finished.
   *
   * The streaming model refines the text as speech goes on and sends the same
   * phrase many times under one `id`: until `final` is set, what has been shown
   * can still change.
   */
  final: boolean
}

/** Events from main to the renderer. */
export interface IpcEvents {
  'live:utterance': LiveUtterance
  'rec:state': RecordingState
  'audio:levels': { mic: number; system: number }
  'meetings:changed': { id: string }
  'stage:progress': StageProgress
  'models:progress': ModelInfo
  'call:detected': { app: string; at: number }
  'toast': { kind: 'info' | 'success' | 'error'; text: string }
  /** Open a particular recording, on a click on a notification for instance. */
  'view:meeting': { id: string }
  /** A request to the renderer to open or close a capture stream. */
  'capture:start': { track: 'mic' | 'system'; micDeviceId?: string }
  'capture:stop': { track: 'mic' | 'system' }
  /** Open a screen without clicking, which test runs need. */
  'debug:view': { kind: 'home' | 'settings' | 'record' | 'meeting'; tab?: string }
}

export type IpcChannel = keyof IpcRequests
export type IpcEventName = keyof IpcEvents
