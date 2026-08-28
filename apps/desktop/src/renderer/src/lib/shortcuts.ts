import { useEffect } from 'react'

/** Печатает ли пользователь прямо сейчас — тогда пробел и буквы не наши. */
function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element) return false
  const tag = element.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable
}

export interface Shortcut {
  /** Клавиша в нижнем регистре: 'f', ' ', 'escape'. */
  key: string
  meta?: boolean
  shift?: boolean
  /** Срабатывать даже когда фокус в поле ввода. */
  whileTyping?: boolean
  run: () => void
}

/**
 * Горячие клавиши окна.
 *
 * Отдельный слой, а не обработчики по компонентам: иначе они расползаются и
 * начинают конфликтовать друг с другом, а понять, что откуда срабатывает,
 * становится нельзя.
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
