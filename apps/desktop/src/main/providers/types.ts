import type { AsrResult, SpeakerTurn } from '@spyly/core'

export interface AsrCapabilities {
  streaming: boolean
  diarization: boolean
  wordTimestamps: boolean
}

export interface TranscribeOptions {
  language: string
  /** 0..1 — для полосы прогресса на странице встречи. */
  onProgress?: (progress: number) => void
  signal?: AbortSignal
}

export interface AsrProvider {
  id: string
  name: string
  local: boolean
  capabilities: AsrCapabilities
  /** Готов ли работать: скачана модель или введён ключ. */
  ready(): Promise<{ ready: boolean; hint?: string }>
  transcribe(wavPath: string, track: 'mic' | 'system', options: TranscribeOptions): Promise<AsrResult>
}

export interface DiarizationProvider {
  id: string
  name: string
  local: boolean
  ready(): Promise<{ ready: boolean; hint?: string }>
  /** Отрезки речи по кластерам внутри одной дорожки. */
  diarize(
    wavPath: string,
    options?: {
      numSpeakers?: number
      /** Порог склейки кластеров; выше — меньше «участников». */
      threshold?: number
      onProgress?: (p: number) => void
    }
  ): Promise<SpeakerTurn[]>
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LlmProvider {
  id: string
  name: string
  local: boolean
  ready(): Promise<{ ready: boolean; hint?: string }>
  complete(messages: LlmMessage[], options?: { maxTokens?: number; temperature?: number }): Promise<string>
}
