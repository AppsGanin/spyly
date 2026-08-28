import { t } from '@spyly/core'
import { getSecret } from '../../store/secrets.js'
import { loadSettings } from '../../store/settings.js'
import type { LlmMessage, LlmProvider } from '../types.js'

/**
 * Любой сервис с API как у OpenAI.
 *
 * Через него подключаются OpenRouter, Groq, Together, локальные vLLM и
 * LM Studio, да и сам OpenAI. Один провайдер вместо десятка: протокол у всех
 * один, различаются только адрес, ключ и название модели.
 */
export const OPENAI_KEY = 'openai-compatible.key'

interface ChatResponse {
  choices?: { message?: { content?: string } }[]
  error?: { message?: string }
}

/** Убираем хвостовой слэш и дописываем /v1, если его забыли. */
export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  // Люди копируют адрес с сайта как есть; у большинства сервисов путь /v1.
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`
}

export const openAiCompatibleProvider: LlmProvider = {
  id: 'openai-compatible',
  name: t('OpenAI-совместимый'),
  local: false,

  async ready() {
    const settings = await loadSettings()
    const { baseUrl, model } = settings.openAiCompatible
    if (!baseUrl.trim()) return { ready: false, hint: t('не указан адрес сервиса') }
    if (!model.trim()) return { ready: false, hint: t('не указана модель') }
    if (!(await getSecret(OPENAI_KEY))) return { ready: false, hint: t('не введён ключ') }
    return { ready: true }
  },

  async complete(messages: LlmMessage[], options = {}) {
    const settings = await loadSettings()
    const { baseUrl, model } = settings.openAiCompatible
    const key = await getSecret(OPENAI_KEY)
    if (!baseUrl || !model || !key) throw new Error(t('OpenAI-совместимый сервис не настроен'))

    // Ключ уходит в заголовок, а туда пускают только ASCII. Ключи такими и
    // бывают, но при копировании со страницы легко прихватить неразрывный
    // пробел или кавычку-ёлочку — и тогда fetch падает с невнятной ошибкой
    // про ByteString вместо понятного «ключ испорчен».
    if (!/^[\x20-\x7e]+$/.test(key)) {
      throw new Error(t('в ключе есть посторонние символы — скопируйте его заново, без пробелов и кавычек'))
    }

    const url = `${normalizeBaseUrl(baseUrl)}/chat/completions`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        // OpenRouter просит их для статистики; остальные заголовок игнорируют.
        'http-referer': 'https://github.com/spyly',
        'x-title': 'Spyly'
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: options.temperature ?? 0.2,
        stream: false
      }),
      signal: AbortSignal.timeout(180_000)
    }).catch((error: unknown) => {
      // «fetch failed» человеку ничего не говорит: подставляем адрес, до
      // которого не достучались, и причину, если она есть.
      const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : ''
      throw new Error(`не удалось связаться с ${url}${cause}`)
    })

    if (!response.ok) {
      // Текст ошибки от сервиса полезнее кода: в нём и «нет денег», и
      // «такой модели нет», и «ключ не тот».
      const detail = await response.text().catch(() => '')
      let message = detail.slice(0, 300)
      try {
        message = (JSON.parse(detail) as ChatResponse).error?.message ?? message
      } catch {
        // Не JSON — оставляем как есть.
      }
      throw new Error(`${response.status}: ${message || response.statusText}`)
    }

    const data = (await response.json()) as ChatResponse
    const text = data.choices?.[0]?.message?.content?.trim()
    if (!text) throw new Error(t('сервис вернул пустой ответ'))
    return text
  }
}
