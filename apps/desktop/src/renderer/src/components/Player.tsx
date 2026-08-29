import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { t, timecode } from '@spyly/core'
import { IconPause, IconPlay } from '../lib/icons'
import { IconButton } from '../ui'

export type PlayerTrack = 'mix' | 'mic' | 'system'

const TRACK_LABELS: Record<PlayerTrack, string> = {
  mix: t('Всё'),
  mic: t('Вы'),
  system: t('Собеседники')
}

/**
 * The recording player with a track selector.
 *
 * The tracks are stored separately, and that matters: if the other side could
 * not be heard, their track is silence, and without a selector that would look
 * like a broken player. "All" mixes both tracks into one.
 */
/**
 * The recording player: track, speed, seeking.
 *
 * Keyboard control lives here as well: space and the arrows have to work from
 * anywhere in the transcript, not only when a button has focus.
 */
export function Player({
  meetingId,
  available,
  seekTo,
  onTime,
  onPlayingChange
}: {
  meetingId: string
  available: PlayerTrack[]
  seekTo: { at: number; n: number } | null
  onTime: (seconds: number) => void
  /** The transcript follows the audio only while it is playing. */
  onPlayingChange?: (playing: boolean) => void
}) {
  const [track, setTrack] = useState<PlayerTrack>(available[0] ?? 'mix')
  const src = `spyly-audio://${meetingId}/${track}.wav`
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  // Nobody is going to listen back to an hour of conversation in real time.
  const [speed, setSpeed] = useState(() => {
    try {
      return Number(localStorage.getItem('spyly.player.speed')) || 1
    } catch {
      return 1
    }
  })

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed
    try {
      localStorage.setItem('spyly.player.speed', String(speed))
    } catch {
      // Private mode: the speed simply will not survive a restart.
    }
  }, [speed, track])

  // The number of the last request carried out. On the first render the request
  // is not carried out but only remembered: otherwise coming back to the tab
  // would switch the audio on by itself.
  const seekDone = useRef<number | null>(null)
  useEffect(() => {
    if (!seekTo) return
    const audio = audioRef.current
    if (!audio) return
    if (seekDone.current === null) {
      seekDone.current = seekTo.n
      return
    }
    if (seekDone.current === seekTo.n) return
    seekDone.current = seekTo.n
    audio.currentTime = seekTo.at
    void audio.play().catch(() => setPlaying(false))
  }, [seekTo])

  // Switching tracks carries on from the same place rather than from the start.
  // The position is restored once the new track's metadata has loaded: before
  // that currentTime cannot be assigned, it gets reset.
  const [restore, setRestore] = useState<{ at: number; play: boolean } | null>(null)

  const switchTrack = (next: PlayerTrack) => {
    if (next === track) return
    setRestore({ at: audioRef.current?.currentTime ?? 0, play: playing })
    setTrack(next)
  }

  // Space and the arrows, as in any player: otherwise listening back turns into
  // fiddling with the mouse.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (typing || event.metaKey || event.ctrlKey) return
      const audio = audioRef.current
      if (!audio) return

      if (event.key === ' ') {
        event.preventDefault()
        if (audio.paused) void audio.play().catch(() => setPlaying(false))
        else audio.pause()
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        audio.currentTime = Math.max(0, audio.currentTime - (event.shiftKey ? 30 : 5))
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (event.shiftKey ? 30 : 5))
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  if (available.length === 0) return null

  const toggle = () => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) void audio.play().catch(() => setPlaying(false))
    else audio.pause()
  }

  const scrub = (event: MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current
    if (!audio || !duration) return
    const rect = event.currentTarget.getBoundingClientRect()
    audio.currentTime = ((event.clientX - rect.left) / rect.width) * duration
  }

  return (
    <div className="player">
      <audio
        key={track}
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => {
          setPlaying(true)
          onPlayingChange?.(true)
        }}
        onPause={() => {
          setPlaying(false)
          onPlayingChange?.(false)
        }}
        onEnded={() => {
          setPlaying(false)
          onPlayingChange?.(false)
        }}
        onLoadedMetadata={(e) => {
          e.currentTarget.playbackRate = speed
          setDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)
          if (restore) {
            e.currentTarget.currentTime = restore.at
            if (restore.play) void e.currentTarget.play().catch(() => setPlaying(false))
            setRestore(null)
          }
        }}
        onTimeUpdate={(e) => {
          setCurrent(e.currentTarget.currentTime)
          onTime(e.currentTarget.currentTime)
        }}
      />
      <IconButton onClick={toggle} aria-label={playing ? t('Пауза') : t('Слушать')}>
        {playing ? <IconPause /> : <IconPlay />}
      </IconButton>
      <span className="player__time">{timecode(current)}</span>
      <div className="player__scrub" onClick={scrub} role="presentation">
        <div className="player__played" style={{ width: duration ? `${(current / duration) * 100}%` : 0 }} />
      </div>
      <span className="player__time">{timecode(duration)}</span>

      <div className="segmented" role="group" aria-label={t('Скорость')}>
        {[1, 1.5, 2].map((rate) => (
          <button
            key={rate}
            className={`segmented__item ${speed === rate ? 'segmented__item--active' : ''}`}
            onClick={() => setSpeed(rate)}
            title={t('Скорость {rate}×', { rate: rate })}
          >
            {rate}×
          </button>
        ))}
      </div>

      {available.length > 1 && (
        <div className="segmented" role="group" aria-label={t('Дорожка')}>
          {available.map((option) => (
            <button
              key={option}
              className={`segmented__item ${track === option ? 'segmented__item--active' : ''}`}
              onClick={() => switchTrack(option)}
            >
              {TRACK_LABELS[option]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
