import { t } from '@spyly/core'
import type { ProviderInfo } from '../../shared/ipc.js'
import { whisperCppProvider } from './asr/whisper-cpp.js'
import { SHERPA_ASR_PROVIDERS, sherpaProviderFor } from './asr/sherpa-asr.js'
import { sherpaDiarizationProvider } from './diarization/sherpa.js'
import { LLM_PROVIDERS, getLlmProvider } from './llm/index.js'
import type { AsrProvider, DiarizationProvider, LlmProvider } from './types.js'

/**
 * Recognition is whisper.cpp only.
 *
 * There used to be three engines, and choosing between them is not something a
 * person can do: comparing them sensibly needs a measurement on their own
 * recordings. We kept one, the best, and reduced the choice to the quality of
 * the model inside it.
 */
export const ASR_PROVIDERS: AsrProvider[] = [whisperCppProvider, ...SHERPA_ASR_PROVIDERS]

/**
 * Which engine transcribes with the chosen model.
 *
 * A person chooses quality, not an engine: the engine is an implementation
 * detail, and comparing them by eye is not possible anyway.
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

/** The list for settings: what is available and what is missing for it to be ready. */
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
