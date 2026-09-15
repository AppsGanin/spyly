import type { AsrResult } from '@spyly/core'
import type { LlmModelChoices } from '../../shared/ipc.js'

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

export interface LlmOptions {
  maxTokens?: number
  temperature?: number
  /** Which model to ask. Absent or empty: whatever the agent itself would use. */
  model?: string
}

export interface LlmReply {
  text: string
  /**
   * The model that actually answered, when that can be learned. "Whatever the
   * agent would use" says nothing a month later, when the default has changed.
   */
  model?: string
}

export interface LlmProvider {
  id: string
  name: string
  local: boolean
  ready(): Promise<{ ready: boolean; hint?: string }>
  complete(messages: LlmMessage[], options?: LlmOptions): Promise<LlmReply>
  /** What settings offer for the model. Absent: the provider has no such choice here. */
  modelChoices?(): Promise<LlmModelChoices>
}
