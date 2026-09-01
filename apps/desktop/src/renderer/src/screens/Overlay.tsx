import { useEffect, useRef, useState } from 'react'
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
  const { recording, levels, settings } = useStore()
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
   * The box is there from the first second, empty.
   *
   * It used to appear with the first recognised word, five to ten seconds in —
   * exactly the stretch when a person is looking for proof that the recording
   * has started. An empty box that says "listening" is that proof; a box that
   * turns up later, on its own, reads as something having gone wrong earlier.
   *
   * When the live text is switched off there is nothing to wait for and no box.
   */
  const showDraft = settings?.liveTranscription !== false
  useEffect(() => {
    void api.call('overlay:draft', showDraft)
  }, [showDraft])

  const mark = async () => {
    try {
      const result = await api.call('rec:mark')
      setMarked(result ? 'ok' : 'fail')
    } catch {
      setMarked('fail')
    }
  }

  return (
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
  )
}

/**
 * The live text under the pill, in a window of its own.
 *
 * Apart from the pill because the pill is small and the text is wide: in one
 * window the space beside the pill would be ours, invisible, and would take the
 * clicks meant for whatever is underneath.
 */
export function OverlayDraft() {
  const { live } = useStore()
  const box = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)

  /*
   * Everything said so far, as one running line.
   *
   * Not the last N characters: that window slid forward with every new word, so
   * the visible text started at a different place each time, rewrapped, and
   * lines a person was in the middle of reading jumped.
   */
  const draft = live
    .map((u) => u.text.trim())
    .filter(Boolean)
    .join(' ')

  /*
   * New words scroll into view, but only for someone already at the end.
   *
   * Scrolled up to read something said a minute ago, a person was thrown back
   * down by the next word and could not finish the sentence. So the box follows
   * the text only while it is standing at the bottom, and lets go the moment
   * one scrolls away from it.
   */
  const onScroll = (): void => {
    const el = box.current
    if (!el) return
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
  }

  useEffect(() => {
    const el = box.current
    if (el && pinned) el.scrollTop = el.scrollHeight
  }, [draft, pinned])

  return (
    <div className="overlay__draft" ref={box} onScroll={onScroll}>
      {draft || <span className="overlay__draft-wait">{t('Слушаю…')}</span>}
    </div>
  )
}
