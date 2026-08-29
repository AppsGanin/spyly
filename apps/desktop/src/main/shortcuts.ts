import { globalShortcut } from 'electron'

/**
 * The shortcut for starting and stopping a recording.
 *
 * A conversation begins suddenly, and there is no time to go looking for the
 * window, so the shortcut is global: it works even when Spyly is hidden behind
 * the call window.
 */

export const RECORD_SHORTCUT = 'CommandOrControl+Shift+R'

let registered = false

export function registerGlobalShortcuts(onToggleRecording: () => void): boolean {
  if (registered) return true
  // The shortcut may be taken by another application: then we simply live
  // without it rather than failing at startup.
  registered = globalShortcut.register(RECORD_SHORTCUT, onToggleRecording)
  return registered
}

export function unregisterGlobalShortcuts(): void {
  globalShortcut.unregisterAll()
  registered = false
}

export function isShortcutRegistered(): boolean {
  return registered
}
