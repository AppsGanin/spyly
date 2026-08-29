/**
 * Participant colours come from the Geist accent scales, so that no foreign
 * palette moves into the system. The order is chosen so that neighbouring
 * speakers are not confused with each other.
 */
export const SPEAKER_ACCENTS = ['blue', 'green', 'purple', 'amber', 'pink', 'teal', 'red'] as const
export type SpeakerAccent = (typeof SPEAKER_ACCENTS)[number]

/** A stable colour by identifier: the same person is always the same colour. */
export function accentFor(speakerId: string, index?: number): SpeakerAccent {
  if (typeof index === 'number') return SPEAKER_ACCENTS[index % SPEAKER_ACCENTS.length]!
  let h = 0
  for (let i = 0; i < speakerId.length; i++) h = (h * 31 + speakerId.charCodeAt(i)) >>> 0
  return SPEAKER_ACCENTS[h % SPEAKER_ACCENTS.length]!
}
