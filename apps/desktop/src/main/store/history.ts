import type { Meeting } from '@spyly/core'
import { updateMeeting } from './meetings.js'

/**
 * Undo and redo of edits to a recording.
 *
 * Snapshots of the edited part are stored rather than inverse operations. An
 * inverse operation would have to be written for each kind of edit separately,
 * and there are seven of them, with splitting an utterance and cutting out a
 * fragment far from obvious. A snapshot works the same for all of them and
 * cannot disagree with what actually happened.
 *
 * Only what a person edits is captured: processing stages, errors and model
 * details are not part of a snapshot, so undo will not roll back the
 * pipeline's result if it finished after the edit.
 *
 * History lives in memory and does not survive a restart, the same as in any
 * editor.
 */

/** The editable part of a recording. */
interface Snapshot {
  title: string
  tags: string[]
  speakers: Meeting['speakers']
  utterances: Meeting['utterances']
  summary: Meeting['summary']
}

interface Step {
  /** What exactly was done: shown to the person when undoing. */
  label: string
  snapshot: Snapshot
}

/** A person will not remember deeper than this anyway, and memory is not infinite. */
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
  // A new edit cuts the redo branch off: there is nowhere left to redo to.
  future.delete(id)
}

/**
 * An edit to a recording that remembers what came before it.
 *
 * The snapshot is taken inside the same lock as the edit itself, and from the
 * very state being edited. Taking it in advance, as a separate read, will not
 * do: two quick edits in a row managed to remember the same state, and the
 * second undo brought back the wrong thing.
 */
export function editWithHistory(
  id: string,
  label: string,
  change: (meeting: Meeting) => Meeting
): Promise<Meeting> {
  return updateMeeting(id, (meeting) => {
    // The callback runs exactly once and under the lock, so changing history here is safe.
    pushPast(id, label, snapshotOf(meeting))
    return change(meeting)
  })
}

/**
 * Mark an irreversible action.
 *
 * Cutting out a fragment changes the audio as well, and a snapshot will not
 * bring it back. Silently undoing the previous edit after that is the worst
 * thing possible: a person presses undo expecting the cut to come back and
 * gets something else entirely. So history simply breaks off.
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
 * A step through history, back or forward.
 *
 * Popping from the stack, pushing onto the opposite one and applying the
 * snapshot all happen inside one lock: otherwise somebody else's edit could
 * wedge itself between reading the current state and writing, and the opposite
 * stack would get something that was no longer on disk.
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
