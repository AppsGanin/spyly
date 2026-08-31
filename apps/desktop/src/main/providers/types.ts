import type { AsrResult } from '@spyly/core'

export interface AsrCapabilities {
  streaming: boolean
  wordTimestamps: boolean
}

export interface TranscribeOptions {
  language: string
  /** 0..1, for the progress bar on the meeting page. */
  onProgress?: (progress: number) => void
  signal?: AbortSignal
}

export interface AsrProvider {
  id: string
  name: string
  local: boolean
  capabilities: AsrCapabilities
  /** Whether it is ready to work: the model downloaded or the key entered. */
  ready(): Promise<{ ready: boolean; hint?: string }>
  transcribe(wavPath: string, track: 'mic' | 'system', options: TranscribeOptions): Promise<AsrResult>
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
