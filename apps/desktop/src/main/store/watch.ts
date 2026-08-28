import { watch, type FSWatcher } from 'node:fs'
import { existsSync } from 'node:fs'
import { meetingsDir } from './paths.js'

/**
 * Слежение за папкой с записями.
 *
 * Файлы — источник правды, и меняет их не только приложение: через MCP в
 * конспект пишет агент, а папку можно поправить и руками. Без слежения такие
 * изменения были бы видны только после перезапуска.
 */
let watcher: FSWatcher | null = null
let timer: NodeJS.Timeout | null = null

export function watchMeetings(onChange: (id: string) => void): void {
  stopWatchingMeetings()
  const dir = meetingsDir()
  if (!existsSync(dir)) return

  // Одна правка файла даёт несколько событий подряд; собираем их в одно.
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
    // Слежение — удобство, а не необходимость: сорваться оно не должно.
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
