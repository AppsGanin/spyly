import { t } from '@spyly/core'
import type { ProviderInfo } from '../../shared/ipc.js'
import { preferredModel, whisperCppProvider } from './asr/whisper-cpp.js'
import { SHERPA_ASR_PROVIDERS, sherpaProviderFor } from './asr/sherpa-asr.js'
import { specById } from './asr/sherpa-specs.js'
import { LLM_PROVIDERS, getLlmProvider, readyLlmProvider } from './llm/index.js'
import type { AsrProvider, LlmProvider } from './types.js'

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
 *
 * A model that knows one language is not handed a conversation in another:
 * GigaAM given an English call turns "release" into "relice" and "Friday" into
 * "Fride". Such a call goes to Whisper, which knows every language; "detect
 * automatically" stays with the chosen model, as a person who chose GigaAM
 * speaks Russian.
 */
export function providerForModel(modelId: string, language = 'auto'): AsrProvider {
  const spec = specById(modelId)
  if (spec && spec.language !== 'multi' && language !== 'auto' && language !== spec.language) {
    return whisperCppProvider
  }
  return sherpaProviderFor(modelId) ?? whisperCppProvider
}

/** The model a transcript is actually made with, to be written into the recording. */
export function modelUsed(provider: AsrProvider, modelId: string): string {
  return provider === whisperCppProvider ? preferredModel() : modelId
}

export { getLlmProvider, readyLlmProvider }

/** The list for settings: what is available and what is missing for it to be ready. */
export async function listProviders(): Promise<ProviderInfo[]> {
  const out: ProviderInfo[] = []
  const collect = async (
    providers: (AsrProvider | LlmProvider)[],
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
  await collect(LLM_PROVIDERS, 'llm')
  return out
}
