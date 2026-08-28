import type { Meeting } from '@spyly/core'
import { updateMeeting } from './meetings.js'

/**
 * Отмена и возврат правок записи.
 *
 * Хранятся снимки правимой части, а не обратные операции. Обратную операцию
 * пришлось бы писать под каждый вид правки отдельно — а их семь, и у разрезания
 * реплики с вырезанием фрагмента она совсем не очевидна. Снимок же одинаково
 * работает для всех и не может разойтись с тем, что случилось на самом деле.
 *
 * Снимается только то, что правит человек: этапы обработки, ошибки и сведения
 * о моделях в снимок не входят, поэтому отмена не откатит результат конвейера,
 * если он доработал уже после правки.
 *
 * История живёт в памяти и не переживает перезапуск — так же, как в любом
 * редакторе.
 */

/** Правимая часть записи. */
interface Snapshot {
  title: string
  tags: string[]
  speakers: Meeting['speakers']
  utterances: Meeting['utterances']
  summary: Meeting['summary']
}

interface Step {
  /** Что именно сделали: показывается человеку при отмене. */
  label: string
  snapshot: Snapshot
}

/** Глубже человек всё равно не помнит, а память не бесконечна. */
const DEPTH = 50

const past = new Map<string, Step[]>()
const future = new Map<string, Step[]>()

function snapshotOf(meeting: Meeting): Snapshot {
  return {
    title: meeting.title,
    tags: [...meeting.tags],
    speakers: meeting.speakers,
    utterances: meeting.utterances,
    summary: meeting.summary
  }
}

function pushPast(id: string, label: string, snapshot: Snapshot): void {
  const steps = past.get(id) ?? []
  steps.push({ label, snapshot })
  if (steps.length > DEPTH) steps.shift()
  past.set(id, steps)
  // Новая правка обрывает ветку возврата: возвращать больше некуда.
  future.delete(id)
}

/**
 * Правка записи с запоминанием того, что было до неё.
 *
 * Снимок делается внутри той же блокировки, что и сама правка, и с того самого
 * состояния, которое правится. Снимать заранее, отдельным чтением, нельзя: две
 * быстрые правки подряд успевали запомнить одно и то же состояние, и вторая
 * отмена возвращала не то.
 */
export function editWithHistory(
  id: string,
  label: string,
  change: (meeting: Meeting) => Meeting
): Promise<Meeting> {
  return updateMeeting(id, (meeting) => {
    // Обратный вызов исполняется ровно один раз и под блокировкой, поэтому
    // менять здесь историю безопасно.
    pushPast(id, label, snapshotOf(meeting))
    return change(meeting)
  })
}

/**
 * Отметить необратимое действие.
 *
 * Вырезание фрагмента меняет и звук, а его снимок не вернёт. Молча отменять
 * после такого предыдущую правку — худшее из возможного: человек нажмёт
 * «отменить», ожидая вернуть вырезанное, и получит совсем другое. Поэтому
 * история просто обрывается.
 */
export function forgetHistory(id: string): void {
  past.delete(id)
  future.delete(id)
}

export function historyState(id: string): { canUndo: boolean; canRedo: boolean } {
  return {
    canUndo: (past.get(id)?.length ?? 0) > 0,
    canRedo: (future.get(id)?.length ?? 0) > 0
  }
}

/**
 * Шаг по истории: назад или вперёд.
 *
 * Снятие со стопки, запись на противоположную и применение снимка происходят
 * внутри одной блокировки — иначе между чтением текущего состояния и записью
 * могла вклиниться чужая правка, и на противоположную стопку попадало бы то,
 * чего на диске уже не было.
 */
async function stepThrough(
  id: string,
  from: Map<string, Step[]>,
  to: Map<string, Step[]>
): Promise<{ meeting: Meeting; label: string } | null> {
  if ((from.get(id)?.length ?? 0) === 0) return null

  let label = ''
  const meeting = await updateMeeting(id, (current) => {
    const step = from.get(id)?.pop()
    if (!step) return current
    label = step.label
    const back = to.get(id) ?? []
    back.push({ label: step.label, snapshot: snapshotOf(current) })
    to.set(id, back)
    return { ...current, ...step.snapshot }
  })
  return label ? { meeting, label } : null
}

export function undo(id: string): Promise<{ meeting: Meeting; label: string } | null> {
  return stepThrough(id, past, future)
}

export function redo(id: string): Promise<{ meeting: Meeting; label: string } | null> {
  return stepThrough(id, future, past)
}
