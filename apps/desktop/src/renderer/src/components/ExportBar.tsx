import { t } from '@spyly/core'
import { useState } from 'react'
import type { PromptTemplate } from '@spyly/core'
import { api } from '../lib/api'
import { IconChevron, IconCopy, IconFolder } from '../lib/icons'
import { useStore } from '../lib/store'
import { Button, Menu } from '../ui'

/** Куда попадал выбор в прошлый раз — чтобы следующий был в одно нажатие. */
const LAST_TEMPLATE_KEY = 'spyly.export.template'

function remembered(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

/**
 * Отдать разговор агенту.
 *
 * Запускать агента из приложения мы больше не пытаемся: у него есть прямой
 * доступ к записям через MCP, и «спроси Claude про вчерашний созвон» работает
 * лучше, чем терминал, открытый нами в случайной папке.
 *
 * Здесь остаётся то, для чего агент не нужен: положить готовый промпт в буфер
 * и показать папку с файлами.
 */
export function ExportBar({
  meetingId,
  ready
}: {
  meetingId: string
  /** Есть ли что отдавать: до расшифровки промпт состоит из одного заголовка. */
  ready: boolean
}) {
  const { settings, notify } = useStore()
  const [busy, setBusy] = useState(false)

  const templates: PromptTemplate[] = settings?.promptTemplates ?? []
  const [templateId, setTemplateId] = useState(() => remembered(LAST_TEMPLATE_KEY, 'tasks'))
  const active = templates.find((t) => t.id === templateId) ?? templates[0]

  const copy = async (id: string) => {
    setBusy(true)
    try {
      await api.call('export:copyPrompt', meetingId, id)
      setTemplateId(id)
      try {
        localStorage.setItem(LAST_TEMPLATE_KEY, id)
      } catch {
        // Приватный режим — выбор просто не переживёт перезапуск.
      }
      const name = templates.find((t) => t.id === id)?.name
      notify('success', name ? t('Промпт «{name}» в буфере', { name: name }) : t('Промпт в буфере'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
      <div className="split">
        <Button
          size="sm"
          className="split__main btn--collapsible"
          disabled={busy || !active || !ready}
          title={
            !ready
              ? t('Расшифровки пока нет, копировать нечего')
              : active
                ? t('Скопировать промпт «{active_name}»', { active_name: active.name })
                : t('Нет ни одного шаблона')
          }
          onClick={() => active && void copy(active.id)}
        >
          <IconCopy /> <span>{busy ? t('Готовлю…') : t('Скопировать промпт')}</span>
        </Button>
        {/* Шаблонов обычно несколько, но выбирают редко — прячем под стрелку. */}
        <Menu
          trigger={
            <Button
              size="sm"
              className="split__more"
              aria-label={t('Выбрать шаблон')}
              title={ready ? t('Выбрать шаблон') : t('Расшифровки пока нет')}
              disabled={!ready}
            >
              <IconChevron style={{ transform: 'rotate(90deg)' }} />
            </Button>
          }
          items={templates.map((template) => ({
            label: template.id === active?.id ? `${template.name} ·` : template.name,
            onSelect: () => void copy(template.id),
            disabled: !ready
          }))}
        />
      </div>

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
