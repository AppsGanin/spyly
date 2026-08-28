import { t } from '@spyly/core'
import type { ProviderInfo } from '../../shared/ipc.js'
import { whisperCppProvider } from './asr/whisper-cpp.js'
import { SHERPA_ASR_PROVIDERS, sherpaProviderFor } from './asr/sherpa-asr.js'
import { sherpaDiarizationProvider } from './diarization/sherpa.js'
import { LLM_PROVIDERS, getLlmProvider } from './llm/index.js'
import type { AsrProvider, DiarizationProvider, LlmProvider } from './types.js'

/**
 * Распознавание — только whisper.cpp.
 *
 * Раньше движков было три, и выбор между ними человек делать не может: чтобы
 * сравнить их осмысленно, нужен замер на своих записях. Оставили один и
 * лучший, а выбор свели к качеству модели внутри него.
 */
export const ASR_PROVIDERS: AsrProvider[] = [whisperCppProvider, ...SHERPA_ASR_PROVIDERS]

/**
 * Какой движок расшифровывает выбранной моделью.
 *
 * Человек выбирает качество, а не движок: движок — это деталь реализации, и
 * сравнить их на глаз всё равно нельзя.
 */
export function providerForModel(modelId: string): AsrProvider {
  return sherpaProviderFor(modelId) ?? whisperCppProvider
}
export const DIARIZATION_PROVIDERS: DiarizationProvider[] = [sherpaDiarizationProvider]

export function getAsrProvider(id: string): AsrProvider {
  return ASR_PROVIDERS.find((p) => p.id === id) ?? whisperCppProvider
}

export function getDiarizationProvider(id: string): DiarizationProvider {
  return DIARIZATION_PROVIDERS.find((p) => p.id === id) ?? sherpaDiarizationProvider
}

export { getLlmProvider }

/** Список для настроек: что доступно и чего не хватает для готовности. */
export async function listProviders(): Promise<ProviderInfo[]> {
  const out: ProviderInfo[] = []
  const collect = async (
    providers: (AsrProvider | DiarizationProvider | LlmProvider)[],
    kind: ProviderInfo['kind']
  ) => {
    for (const provider of providers) {
      const status = await provider.ready().catch(() => ({ ready: false, hint: t('проверка не удалась') }))
      out.push({
        id: provider.id,
        name: provider.name,
        kind,
        local: provider.local,
        ready: status.ready,
        hint: status.hint
      })
    }
  }
  await collect(ASR_PROVIDERS, 'asr')
  await collect(DIARIZATION_PROVIDERS, 'diarization')
  await collect(LLM_PROVIDERS, 'llm')
  return out
}
