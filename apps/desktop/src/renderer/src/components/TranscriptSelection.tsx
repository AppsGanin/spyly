import { useEffect, useState } from 'react'
import { t, speakerLabel, timecode, type Meeting } from '@spyly/core'
import { IconCopy } from '../lib/icons'
import { useStore } from '../lib/store'

/**
 * Copying a selected piece of the transcript.
 *
 * An ordinary mouse selection, which people already know how to use. A button
 * appears next to the selection and hands over the text with timestamps and
 * names rather than the bare string without context the browser would give.
 */
export function TranscriptSelection({ meeting }: { meeting: Meeting }) {
  const { notify } = useStore()
  const [box, setBox] = useState<{ top: number; left: number; ids: string[] } | null>(null)

  useEffect(() => {
    const update = () => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        setBox(null)
        return
      }
      const range = selection.getRangeAt(0)
      const ids: string[] = []
      for (const node of document.querySelectorAll<HTMLElement>('[data-utterance]')) {
        if (range.intersectsNode(node)) ids.push(node.dataset.utterance!)
      }
      if (ids.length === 0) {
        setBox(null)
        return
      }
      const rect = range.getBoundingClientRect()
      setBox({ top: rect.top - 42, left: rect.left, ids })
    }

    document.addEventListener('selectionchange', update)
    return () => document.removeEventListener('selectionchange', update)
  }, [])

  if (!box) return null

  const copy = async () => {
    const speakers = new Map(meeting.speakers.map((s) => [s.id, s]))
    const text = meeting.utterances
      .filter((u) => box.ids.includes(u.id))
      .map((u) => `[${timecode(u.start)}] ${speakerLabel(speakers.get(u.speakerId), u.speakerId)}: ${u.text}`)
      .join('\n')
    await navigator.clipboard.writeText(text)
    notify('success', t('Скопировано реплик: {box_ids_length}', { box_ids_length: box.ids.length }))
    window.getSelection()?.removeAllRanges()
    setBox(null)
  }

  return (
    <button
      className="selcopy"
      style={{ top: Math.max(8, box.top), left: box.left }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => void copy()}
    >
      <IconCopy /> {t('Скопировать {n} с таймкодами', { n: box.ids.length })}
    </button>
  )
}
