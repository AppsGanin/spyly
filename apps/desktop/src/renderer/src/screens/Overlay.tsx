import { useEffect, useState } from 'react'
import { t, timecode } from '@spyly/core'
import { api } from '../lib/api'
import { IconCheck, IconFlag, IconPause, IconPlay, IconStop } from '../lib/icons'
import { useStore } from '../lib/store'
import { LevelMeter } from '../ui'

/**
 * The floating panel above every window.
 *
 * During a call the Spyly window is covered by somebody else's: a browser,
 * Zoom, an editor. And that is exactly when a "this bit matters" mark has to be
 * placed, or when it has to be visible that recording is still running. The
 * panel is small, always on top, and does exactly four things — plus showing
 * the words as they are recognised, so a person can see the recording is not
 * silently writing nothing.
 */
export function Overlay() {
  const { recording, levels, live } = useStore()
  const [marked, setMarked] = useState<'ok' | 'fail' | null>(null)
  const paused = recording.status === 'paused'

  // The confirmation is shown on the button itself: there are no toasts in this
  // window, and pressing blind with no answer looks as though nothing happened.
  useEffect(() => {
    if (!marked) return
    const timer = setTimeout(() => setMarked(null), 1400)
    return () => clearTimeout(timer)
  }, [marked])

  /*
   * Everything said so far, as one running line.
   *
   * Not the last N characters: that window slid forward with every new word, so
   * the visible text started at a different place each time, rewrapped, and
   * lines a person was in the middle of reading jumped. The whole text is kept
   * instead and the box shows its end, which leaves earlier lines exactly where
   * they were.
   */
  const draft = live
    .map((u) => u.text.trim())
    .filter(Boolean)
    .join(' ')

  // The window is transparent but still catches clicks, so it grows only while
  // there is something to show.
  useEffect(() => {
    void api.call('overlay:draft', draft.length > 0)
  }, [draft.length > 0])

  const mark = async () => {
    try {
      const result = await api.call('rec:mark')
      setMarked(result ? 'ok' : 'fail')
    } catch {
      setMarked('fail')
    }
  }

  return (
    <div className="overlay__stack">
      <div className={`overlay ${paused ? 'overlay--paused' : ''}`}>
      <span className={`overlay__dot ${paused ? 'overlay__dot--paused' : ''}`} />
      <span className="overlay__time mono">{timecode(recording.elapsedSec)}</span>

      <LevelMeter level={Math.max(levels.mic, levels.system)} bars={5} />

      <button
        className={`overlay__btn ${marked === 'ok' ? 'overlay__btn--done' : ''} ${
          marked === 'fail' ? 'overlay__btn--failed' : ''
        }`}
        title={marked === 'ok' ? t('Отмечено') : t('Отметить важное')}
        onClick={() => void mark()}
      >
        {marked === 'ok' ? <IconCheck /> : <IconFlag />}
      </button>
      <button
        className="overlay__btn"
        title={paused ? t('Продолжить') : t('Пауза')}
        onClick={() => void api.call(paused ? 'rec:resume' : 'rec:pause')}
      >
        {paused ? <IconPlay /> : <IconPause />}
      </button>
      <button
        className="overlay__btn overlay__btn--stop"
        title={t('Остановить запись')}
        onClick={() => void api.call('rec:stop')}
      >
        <IconStop />
      </button>
      </div>

      {draft && <div className="overlay__draft">{draft}</div>}
    </div>
  )
}
