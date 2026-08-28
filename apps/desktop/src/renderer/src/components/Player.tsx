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
 * Плеер записи с выбором дорожки.
 *
 * Дорожки хранятся раздельно, и это важно: если собеседника не было слышно,
 * на его дорожке тишина — без переключателя это выглядело бы как сломанный
 * плеер. «Всё» сводит обе дорожки в одну.
 */
/**
 * Плеер записи: дорожка, скорость, перемотка.
 *
 * Управление с клавиатуры вынесено сюда же — пробел и стрелки должны работать
 * из любого места расшифровки, а не только когда фокус на кнопке.
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
  /** Расшифровка едет за звуком только пока он играет. */
  onPlayingChange?: (playing: boolean) => void
}) {
  const [track, setTrack] = useState<PlayerTrack>(available[0] ?? 'mix')
  const src = `spyly-audio://${meetingId}/${track}.wav`
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  // Час разговора в реальном времени никто переслушивать не станет.
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
      // Приватный режим — скорость просто не переживёт перезапуск.
    }
  }, [speed, track])

  // Номер последней исполненной просьбы. На первом отрисовывании просьбу не
  // исполняем, а лишь запоминаем: иначе возврат на вкладку сам включал бы звук.
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

  // При смене дорожки продолжаем с того же места, а не с начала.
  // Позиция восстанавливается после загрузки метаданных новой дорожки:
  // до этого момента currentTime присвоить нельзя, он сбрасывается.
  const [restore, setRestore] = useState<{ at: number; play: boolean } | null>(null)

  const switchTrack = (next: PlayerTrack) => {
    if (next === track) return
    setRestore({ at: audioRef.current?.currentTime ?? 0, play: playing })
    setTrack(next)
  }

  // Пробел и стрелки — как в любом плеере: иначе переслушивание превращается
  // в возню с мышью.
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
