import { t } from '@spyly/core'

import type { ActionItem, Meeting } from '@spyly/core'
import { IconSparkle } from '../lib/icons'
import { Button, EmptyState } from '../ui'

/** The model often writes a deadline with a preposition already, so a second "by" is redundant. */
function formatDue(due: string): string {
  const trimmed = due.trim()
  return /^(до|к|by|until)\s/i.test(trimmed) ? trimmed : t('до {trimmed}', { trimmed: trimmed })
}

/** A list from the summary. Empty sections are not shown at all. */
function ListSection({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null

  return (
    <section className="summary__section">
      <h4>{title}</h4>
      <ul className="summary__list">
        {items.map((item, index) => (
          <li key={`${index}-${item.slice(0, 12)}`}>{item}</li>
        ))}
      </ul>
    </section>
  )
}

/**
 * A task from the summary.
 *
 * Read-only, the box included: whether a task is done is changed by an agent
 * over MCP, where the task is actually being worked on, rather than by ticking
 * a box in a window nobody has open at the time.
 */
function TaskRow({ item }: { item: ActionItem }) {
  return (
    <li className={`summary__task ${item.done ? 'task-card__text--done' : ''}`}>
      <span className="grow">{item.text}</span>
      {item.assignee && <span className="summary__taskMeta">{item.assignee}</span>}
      {item.due && <span className="summary__taskMeta">{formatDue(item.due)}</span>}
    </li>
  )
}

/**
 * The summary: what the model made of the conversation.
 *
 * Nothing here is edited by hand any more. A summary is an account of what was
 * said; once it can be typed into, a thought added afterwards looks exactly
 * like one that was spoken, and a month later there is no telling them apart.
 * What the machine got wrong is fixed by rebuilding it, or by an agent over
 * MCP, which leaves a trace of who changed what.
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
  const summary = meeting.summary
  const empty = meeting.utterances.length === 0

  if (!summary) {
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
                : t('Нужна языковая модель. Подойдёт установленный Claude Code или Codex, либо локальная Ollama.')
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
      <div className="summary__tldr">{summary.tldr}</div>

      <ListSection title={t('Основное')} items={summary.keyPoints} />
      <ListSection title={t('Решили')} items={summary.decisions} />

      {summary.actionItems.length > 0 && (
        <section className="summary__section">
          <h4>{t('Задачи')}</h4>
          <ul className="summary__list">
            {summary.actionItems.map((item, index) => (
              <TaskRow key={`${index}-${item.text.slice(0, 12)}`} item={item} />
            ))}
          </ul>
        </section>
      )}

      <ListSection title={t('Осталось решить')} items={summary.questions} />

      {canSummarize && (
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <Button size="sm" onClick={onGenerate} disabled={generating}>
            {generating ? t('Пересобираю…') : t('Пересобрать конспект')}
          </Button>
        </div>
      )}
    </div>
  )
}

export { formatDue }
