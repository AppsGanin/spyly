import { globalShortcut } from 'electron'

/**
 * The shortcut for starting and stopping a recording.
 *
 * A conversation begins suddenly, and there is no time to go looking for the
 * window, so the shortcut is global: it works even when Spyly is hidden behind
 * the call window.
 */

let current: string | null = null
let registered = false
let onToggle: () => void = () => undefined

function register(accelerator: string): boolean {
  try {
    return globalShortcut.register(accelerator, onToggle)
  } catch {
    // An accelerator Electron cannot parse throws rather than returning false.
    return false
  }
}

export function registerGlobalShortcuts(accelerator: string, onToggleRecording: () => void): boolean {
  if (registered) return true
  onToggle = onToggleRecording
  current = accelerator
  // The shortcut may be taken by another application: then we simply live
  // without it rather than failing at startup.
  registered = register(accelerator)
  return registered
}

/**
 * Put another combination in place of the current one.
 *
 * The old one is let go first, otherwise pressing the same keys again would
 * count as taken. If the new one cannot be had, the old one comes back: a
 * person who picked a busy combination should not end up with none.
 */
export function changeRecordShortcut(accelerator: string): boolean {
  if (accelerator === current && registered) return true
  const previous = current
  if (registered && previous) globalShortcut.unregister(previous)

  if (register(accelerator)) {
    current = accelerator
    registered = true
    return true
  }
  registered = previous ? register(previous) : false
  return false
}

/**
 * Let go of the shortcut while a new one is being typed in settings.
 *
 * Otherwise pressing the current combination to see it again starts a
 * recording instead of reaching the window.
 */
export function pauseRecordShortcut(paused: boolean): void {
  if (!current) return
  if (paused && registered) {
    globalShortcut.unregister(current)
    registered = false
  } else if (!paused && !registered) {
    registered = register(current)
  }
}

export function unregisterGlobalShortcuts(): void {
  globalShortcut.unregisterAll()
  registered = false
}
