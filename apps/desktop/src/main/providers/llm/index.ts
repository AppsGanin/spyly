import { t } from '@spyly/core'
import type { LlmProvider } from '../types.js'
import { CLI_LLM_PROVIDERS } from './cli.js'
import { openAiCompatibleProvider } from './openai-compatible.js'

/**
 * Модели для конспекта.
 *
 * По умолчанию — то, что не требует ключа: уже авторизованные кодинг-агенты и
 * локальная Ollama. Отдельно есть OpenAI-совместимый вход — через него
 * подключается OpenRouter и всё остальное с тем же протоколом; там запись
 * уходит на чужой сервер, и в интерфейсе про это сказано прямо.
 */

async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`${response.status} ${response.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`)
  }
  return response.json()
}

/** Локальная модель через Ollama — без аккаунта и без отправки записи наружу. */
const ollamaProvider: LlmProvider = {
  id: 'ollama',
  name: t('Ollama (локально)'),
  local: true,
  async ready() {
    try {
      const response = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(1200) })
      if (!response.ok) return { ready: false, hint: t('Ollama не отвечает') }
      const data = (await response.json()) as { models?: { name: string }[] }
      if (!data.models?.length) return { ready: false, hint: t('в Ollama нет ни одной модели') }
      return { ready: true }
    } catch {
      return { ready: false, hint: t('Ollama не запущена') }
    }
  },
  async complete(messages, options = {}) {
    const tags = (await (await fetch('http://127.0.0.1:11434/api/tags')).json()) as {
      models?: { name: string }[]
    }
    const model = tags.models?.[0]?.name
    if (!model) throw new Error(t('в Ollama нет ни одной модели'))
    const data = (await postJson('http://127.0.0.1:11434/api/chat', {
      model,
      messages,
      stream: false,
      options: { temperature: options.temperature ?? 0.2 }
    })) as { message?: { content?: string } }
    return data.message?.content ?? ''
  }
}

export const LLM_PROVIDERS: LlmProvider[] = [
  ...CLI_LLM_PROVIDERS,
  ollamaProvider,
  openAiCompatibleProvider
]

export function getLlmProvider(id: string): LlmProvider | null {
  return LLM_PROVIDERS.find((p) => p.id === id) ?? null
}
