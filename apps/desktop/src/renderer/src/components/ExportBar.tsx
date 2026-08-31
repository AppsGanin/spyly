import { t } from '@spyly/core'
import { useState } from 'react'
import { api } from '../lib/api'
import { IconCopy, IconFolder } from '../lib/icons'
import { useStore } from '../lib/store'
import { Button } from '../ui'

/**
 * Handing a conversation to an agent.
 *
 * We no longer try to start an agent from the application: it has direct
 * access to recordings over MCP, and "ask Claude about yesterday's call" works
 * better than a terminal we opened in some arbitrary folder.
 *
 * What remains here is what needs no agent: putting the conversation on the
 * clipboard and showing the folder with the files. There is no instruction to
 * choose in front of it any more: what a person wants from the conversation
 * they type themselves, in the words of the moment.
 */
export function ExportBar({
  meetingId,
  ready
}: {
  meetingId: string
  /** Whether there is anything to hand over: before transcription the prompt is one heading. */
  ready: boolean
}) {
  const { notify } = useStore()
  const [busy, setBusy] = useState(false)

  const copy = async () => {
    setBusy(true)
    try {
      await api.call('export:copyPrompt', meetingId)
      notify('success', t('Промпт в буфере'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
      <Button
        size="sm"
        className="btn--collapsible"
        disabled={busy || !ready}
        title={ready ? t('Скопировать разговор для агента') : t('Расшифровки пока нет, копировать нечего')}
        onClick={() => void copy()}
      >
        <IconCopy /> <span>{busy ? t('Готовлю…') : t('Скопировать промпт')}</span>
      </Button>

      <Button
        size="sm"
        variant="ghost"
        className="btn--collapsible"
        title={t('Показать файлы')}
        onClick={() => void api.call('export:revealFolder', meetingId)}
      >
        <IconFolder /> <span>{t('Показать файлы')}</span>
      </Button>
    </div>
  )
}
