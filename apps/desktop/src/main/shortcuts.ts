import { globalShortcut } from 'electron'

/**
 * Горячая клавиша начала и остановки записи.
 *
 * Разговор начинается внезапно, и искать окно в этот момент некогда — поэтому
 * сочетание глобальное: работает, даже когда Spyly спрятан за окном созвона.
 */

export const RECORD_SHORTCUT = 'CommandOrControl+Shift+R'

let registered = false

export function registerGlobalShortcuts(onToggleRecording: () => void): boolean {
  if (registered) return true
  // Сочетание может быть занято другим приложением: тогда просто живём без
  // него, а не падаем на старте.
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
