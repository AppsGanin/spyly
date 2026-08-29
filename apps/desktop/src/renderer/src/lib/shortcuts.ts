import { useEffect } from 'react'

/** Whether the user is typing right now, in which case space and letters are not ours. */
function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element) return false
  const tag = element.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable
}

export interface Shortcut {
  /** The key in lower case: 'f', ' ', 'escape'. */
  key: string
  meta?: boolean
  shift?: boolean
  /** Fire even when the focus is in an input field. */
  whileTyping?: boolean
  run: () => void
}

/**
 * Window shortcuts.
 *
 * A layer of its own rather than handlers scattered across components:
 * otherwise they spread out and start conflicting with each other, and working
 * out what fires from where becomes impossible.
 */
export function useShortcuts(shortcuts: Shortcut[]): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const typing = isTyping(event.target)
      for (const shortcut of shortcuts) {
        if (typing && !shortcut.whileTyping) continue
        if (event.key.toLowerCase() !== shortcut.key) continue
        if (Boolean(shortcut.meta) !== (event.metaKey || event.ctrlKey)) continue
        if (Boolean(shortcut.shift) !== event.shiftKey) continue
        event.preventDefault()
        shortcut.run()
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [shortcuts])
}
