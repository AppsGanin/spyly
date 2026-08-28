/**
 * Цвета участников берутся из акцентных шкал Geist, чтобы в систему не заезжала
 * чужая палитра. Порядок подобран так, чтобы соседние спикеры не путались.
 */
export const SPEAKER_ACCENTS = ['blue', 'green', 'purple', 'amber', 'pink', 'teal', 'red'] as const
export type SpeakerAccent = (typeof SPEAKER_ACCENTS)[number]

/** Стабильный цвет по идентификатору: один и тот же человек всегда одного цвета. */
export function accentFor(speakerId: string, index?: number): SpeakerAccent {
  if (typeof index === 'number') return SPEAKER_ACCENTS[index % SPEAKER_ACCENTS.length]!
  let h = 0
  for (let i = 0; i < speakerId.length; i++) h = (h * 31 + speakerId.charCodeAt(i)) >>> 0
  return SPEAKER_ACCENTS[h % SPEAKER_ACCENTS.length]!
}
