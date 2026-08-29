import { watch, type FSWatcher } from 'node:fs'
import { existsSync } from 'node:fs'
import { meetingsDir } from './paths.js'

/**
 * Watching the recordings folder.
 *
 * Files are the source of truth, and it is not only the application that
 * changes them: an agent writes into the summary over MCP, and the folder can
 * be edited by hand too. Without watching, such changes would only show up
 * after a restart.
 */
let watcher: FSWatcher | null = null
let timer: NodeJS.Timeout | null = null

export function watchMeetings(onChange: (id: string) => void): void {
  stopWatchingMeetings()
  const dir = meetingsDir()
  if (!existsSync(dir)) return

  // One edit to a file produces several events in a row; they are collected into one.
  const pending = new Set<string>()
  const flush = () => {
    timer = null
    for (const id of pending) onChange(id)
    pending.clear()
  }

  try {
    watcher = watch(dir, { recursive: true }, (_event, name) => {
      if (!name) return
      const id = String(name).split('/')[0]
      if (!id || id.startsWith('.')) return
      pending.add(id)
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, 400)
    })
    // Watching is a convenience, not a necessity: it must not break anything.
    watcher.on('error', () => stopWatchingMeetings())
  } catch {
    watcher = null
  }
}

export function stopWatchingMeetings(): void {
  if (timer) clearTimeout(timer)
  timer = null
  watcher?.close()
  watcher = null
}
