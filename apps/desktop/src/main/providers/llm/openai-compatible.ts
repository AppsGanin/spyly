import { t } from '@spyly/core'
import { getSecret } from '../../store/secrets.js'
import { loadSettings } from '../../store/settings.js'
import type { LlmMessage, LlmProvider } from '../types.js'

/**
 * Any service with an API like OpenAI's.
 *
 * This is how OpenRouter, Groq, Together, local vLLM and LM Studio connect,
 * and OpenAI itself. One provider instead of a dozen: the protocol is the same
 * for all of them, only the address, the key and the model name differ.
 */
export const OPENAI_KEY = 'openai-compatible.key'

interface ChatResponse {
  choices?: { message?: { content?: string } }[]
  error?: { message?: string }
}

/** Strip a trailing slash and add /v1 if it was forgotten. */
export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  // People copy the address off a website as it is; most services have a /v1 path.
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

    // The key goes into a header, and only ASCII is allowed there. Keys usually
    // are, but copying from a page easily brings along a non-breaking space or a
    // typographic quote, and then fetch fails with an obscure error about
    // ByteString instead of a plain "the key is damaged".
    if (!/^[\x20-\x7e]+$/.test(key)) {
      throw new Error(t('в ключе есть посторонние символы — скопируйте его заново, без пробелов и кавычек'))
    }

    const url = `${normalizeBaseUrl(baseUrl)}/chat/completions`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        // OpenRouter asks for these for its statistics; the others ignore the header.
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
      // "fetch failed" tells a person nothing: we add the address that could not be
      // reached, and the reason if there is one.
      const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : ''
      throw new Error(t('не удалось связаться с {url}{cause}', { url, cause }))
    })

    if (!response.ok) {
      // The service's error text is more useful than the code: it covers "out of
      // funds", "no such model" and "wrong key" alike.
      const detail = await response.text().catch(() => '')
      let message = detail.slice(0, 300)
      try {
        message = (JSON.parse(detail) as ChatResponse).error?.message ?? message
      } catch {
        // Not JSON, so leave it as it is.
      }
      throw new Error(`${response.status}: ${message || response.statusText}`)
    }

    const data = (await response.json()) as ChatResponse
    const text = data.choices?.[0]?.message?.content?.trim()
    if (!text) throw new Error(t('сервис вернул пустой ответ'))
    return text
  }
}
