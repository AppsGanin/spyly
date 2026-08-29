import { t } from '@spyly/core'

/** A marker that the summary was edited by hand. The value is internal and is not translated. */
const MANUAL_MODEL = 'вручную'
import { useEffect, useState } from 'react'
import type { ActionItem, Meeting, Summary } from '@spyly/core'
import { IconClose, IconSparkle } from '../lib/icons'
import { Button, EmptyState, IconButton, Input } from '../ui'

/** The model often writes a deadline with a preposition already, so a second "by" is redundant. */
function formatDue(due: string): string {
  const trimmed = due.trim()
  return /^(до|к|by|until)\s/i.test(trimmed) ? trimmed : t('до {trimmed}', { trimmed: trimmed })
}

/** An editable list row: click to edit, empty means deleted. */
function EditableLine({
  value,
  placeholder,
  onChange,
  onRemove
}: {
  value: string
  placeholder: string
  onChange: (next: string) => void
  onRemove: () => void
}) {
  return (
    <div className="editline">
      <div
        className="editline__text"
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onBlur={(e) => {
          const next = (e.currentTarget.textContent ?? '').trim()
          if (next !== value) onChange(next)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            e.currentTarget.blur()
          }
        }}
      >
        {value}
      </div>
      <IconButton className="editline__remove" aria-label={t('Убрать пункт')} onClick={onRemove}>
        <IconClose />
      </IconButton>
    </div>
  )
}

function ListSection({
  title,
  items,
  placeholder,
  onChange
}: {
  title: string
  items: string[]
  placeholder: string
  onChange: (next: string[]) => void
}) {
  const [draft, setDraft] = useState('')

  const add = () => {
    if (!draft.trim()) return
    onChange([...items, draft.trim()])
    setDraft('')
  }

  if (items.length === 0 && !draft) {
    return (
      <section className="summary__section">
        <h4>{title}</h4>
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
          onBlur={add}
        />
      </section>
    )
  }

  return (
    <section className="summary__section">
      <h4>{title}</h4>
      <div className="col" style={{ gap: 4 }}>
        {items.map((item, index) => (
          <EditableLine
            key={`${index}-${item.slice(0, 12)}`}
            value={item}
            placeholder={t('Пункт')}
            onChange={(next) =>
              onChange(next ? items.map((v, i) => (i === index ? next : v)) : items.filter((_, i) => i !== index))
            }
            onRemove={() => onChange(items.filter((_, i) => i !== index))}
          />
        ))}
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
          onBlur={add}
        />
      </div>
    </section>
  )
}

function TaskRow({
  item,
  onChange,
  onRemove
}: {
  item: ActionItem
  onChange: (next: ActionItem) => void
  onRemove: () => void
}) {
  return (
    <div className="taskrow">
      <input
        type="checkbox"
        className="taskrow__check"
        checked={item.done}
        aria-label={t('Сделано: {item_text}', { item_text: item.text })}
        onChange={() => onChange({ ...item, done: !item.done })}
      />
      <div
        className={`editline__text grow ${item.done ? 'task-card__text--done' : ''}`}
        contentEditable
        suppressContentEditableWarning
        onBlur={(e) => {
          const text = (e.currentTarget.textContent ?? '').trim()
          if (text !== item.text) onChange({ ...item, text })
        }}
      >
        {item.text}
      </div>
      <Input
        className="taskrow__meta taskrow__who"
        value={item.assignee ?? ''}
        placeholder={t('кто')}
        aria-label={t('Исполнитель')}
        onChange={(e) => onChange({ ...item, assignee: e.target.value || undefined })}
      />
      <Input
        className="taskrow__meta taskrow__when"
        value={item.due ?? ''}
        placeholder={t('срок')}
        aria-label={t('Срок')}
        onChange={(e) => onChange({ ...item, due: e.target.value || undefined })}
      />
      <IconButton className="taskrow__remove" aria-label={t('Убрать задачу')} onClick={onRemove}>
        <IconClose />
      </IconButton>
    </div>
  )
}

/**
 * The summary: what the model assembled, and what a person corrected in it.
 *
 * Everything is editable: the machine regularly attributes a task to the wrong
 * person and invents deadlines, and rebuilding the whole summary over one
 * mistake is a poor trade.
 */
export function SummaryPanel({
  meeting,
  onGenerate,
  onOpenSettings,
  generating,
  canSummarize
}: {
  meeting: Meeting
  onGenerate: () => void
  onOpenSettings: () => void
  generating: boolean
  canSummarize: boolean
}) {
  const [draft, setDraft] = useState<Summary | null>(meeting.summary ?? null)
  const [dirty, setDirty] = useState(false)
  const empty = meeting.utterances.length === 0

  // A rebuilt summary should displace the draft without wiping an unsaved edit.
  useEffect(() => {
    if (!dirty) setDraft(meeting.summary ?? null)
  }, [meeting.summary, dirty])

  const patch = (next: Partial<Summary>) => {
    if (!draft) return
    setDraft({ ...draft, ...next })
    setDirty(true)
  }

  const save = async () => {
    if (!draft) return
    const { api } = await import('../lib/api')
    await api.call('meetings:updateSummary', meeting.id, draft)
    setDirty(false)
  }

  if (!draft) {
    const failed = meeting.stages.summarizing === 'failed'
    return (
      <EmptyState
        icon={<IconSparkle size={22} />}
        title={failed ? t('Конспект не получился') : t('Конспекта пока нет')}
        text={
          failed
            ? (meeting.errors.summarizing ?? t('Не удалось обратиться к модели.'))
            : empty
              ? t('Сначала нужна расшифровка: собирать конспект пока не из чего.')
              : canSummarize
                ? t('Соберём краткое содержание, решения и задачи из расшифровки.')
                : t('Нужна языковая модель. Подойдёт установленный Claude Code, Codex или Ollama: ключ и оплата по токенам не понадобятся.')
        }
        action={
          canSummarize ? (
            <Button variant="primary" onClick={onGenerate} disabled={generating || empty}>
              {generating ? t('Собираю…') : t('Собрать конспект')}
            </Button>
          ) : (
            <Button variant="primary" onClick={onOpenSettings}>{t('Как это настроить')}</Button>
          )
        }
      />
    )
  }

  return (
    <div className="summary">
      <div
        className="summary__tldr editline__text"
        contentEditable
        suppressContentEditableWarning
        data-placeholder={t('О чём был разговор')}
        onBlur={(e) => {
          const tldr = (e.currentTarget.textContent ?? '').trim()
          if (tldr !== draft.tldr) patch({ tldr })
        }}
      >
        {draft.tldr}
      </div>

      <ListSection
        title={t('Основное')}
        items={draft.keyPoints}
        placeholder={t('Добавить тезис')}
        onChange={(keyPoints) => patch({ keyPoints })}
      />
      <ListSection
        title={t('Решили')}
        items={draft.decisions}
        placeholder={t('Добавить решение')}
        onChange={(decisions) => patch({ decisions })}
      />

      <section className="summary__section">
        <h4>{t('Задачи')}</h4>
        <div className="col" style={{ gap: 4 }}>
          {draft.actionItems.map((item, index) => (
            <TaskRow
              key={`${index}-${item.text.slice(0, 12)}`}
              item={item}
              onChange={(next) =>
                patch({ actionItems: draft.actionItems.map((v, i) => (i === index ? next : v)) })
              }
              onRemove={() => patch({ actionItems: draft.actionItems.filter((_, i) => i !== index) })}
            />
          ))}
          <Button
            size="sm"
            onClick={() => patch({ actionItems: [...draft.actionItems, { text: t('Новая задача'), done: false }] })}
          >{t('Добавить задачу')}</Button>
        </div>
      </section>

      <ListSection
        title={t('Осталось решить')}
        items={draft.questions}
        placeholder={t('Добавить вопрос')}
        onChange={(questions) => patch({ questions })}
      />

      <div className="row" style={{ gap: 'var(--space-2)' }}>
        {dirty && (
          <Button variant="primary" size="sm" onClick={() => void save()}>{t('Сохранить правки')}</Button>
        )}
        {dirty && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft(meeting.summary ?? null)
              setDirty(false)
            }}
          >{t('Отменить')}</Button>
        )}
        {!dirty && canSummarize && (
          <Button size="sm" onClick={onGenerate} disabled={generating}>
            {generating ? t('Пересобираю…') : t('Пересобрать конспект')}
          </Button>
        )}
        {!dirty && draft.model === MANUAL_MODEL && <span className="dim">{t('Правлено вручную')}</span>}
      </div>
    </div>
  )
}

export { formatDue }
