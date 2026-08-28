import { useEffect, useRef } from 'react'
import { t, timecode } from '@spyly/core'
import type { LiveUtterance } from '@shared/ipc'

/**
 * Черновая расшифровка по ходу разговора.
 *
 * Показывается курсивом и без имён участников: кто говорит, станет понятно
 * только после финального прохода, а врать в реальном времени хуже, чем
 * честно сказать «вы» и «собеседник».
 */
export function LiveTranscript({ utterances }: { utterances: LiveUtterance[] }) {
  const bottom = useRef<HTMLDivElement>(null)

  // Ведём не по числу реплик, а по тексту последней: фраза дописывается на
  // месте, и её конец уезжает за нижний край, не меняя длины списка.
  const tail = utterances[utterances.length - 1]?.text ?? ''
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [utterances.length, tail])

  if (utterances.length === 0) {
    return (
      <p className="dim" style={{ lineHeight: 'var(--leading-relaxed)', maxWidth: 640 }}>{t('Текст появится, как только прозвучат первые слова. Точная расшифровка с именами участников соберётся после остановки записи.')}</p>
    )
  }

  return (
    <div className="transcript">
      {utterances.map((utterance) => (
        <div key={utterance.id} className="utterance utterance--provisional">
          <span className="utterance__time mono">{timecode(utterance.start)}</span>
          <div>
            <div
              className="utterance__speaker"
              style={{ color: utterance.track === 'mic' ? 'var(--ds-green-900)' : 'var(--ds-blue-900)' }}
            >
              <span
                className="speaker-dot"
                style={{ background: utterance.track === 'mic' ? 'var(--ds-green-900)' : 'var(--ds-blue-900)' }}
              />
              {utterance.track === 'mic' ? t('Вы') : t('Собеседник')}
            </div>
            <div className="utterance__text">
              {utterance.text}
              {!utterance.final && <span className="utterance__cursor" aria-hidden="true" />}
            </div>
          </div>
        </div>
      ))}
      <div ref={bottom} />
    </div>
  )
}
