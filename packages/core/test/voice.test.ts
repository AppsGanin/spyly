import { describe, expect, it } from 'vitest'
import { identifySpeakers } from '../src/voice.js'
import type { VoiceProfile } from '../src/types.js'

/**
 * Recognising your own voice on your own track is gentler: there is nobody to
 * confuse you with, while failing to recognise yourself is easy, as the print
 * is noisy on short utterances. On a real recording the owner's own voice
 * scored 0.52 against the general threshold of 0.62 and stayed "In the room 1".
 */
describe('recognition by voice', () => {
  const me: VoiceProfile = {
    id: 'v1',
    name: 'Я',
    isMe: true,
    embedding: [1, 0, 0],
    createdAt: '',
    updatedAt: '',
    samples: 1
  }
  const other: VoiceProfile = { ...me, id: 'v2', name: 'Мария', isMe: false }

  // A closeness of about 0.52, as on a real recording.
  const weak = [0.52, 0.854, 0]
  const strong = [0.95, 0.312, 0]

  it('recognises you on the microphone track on a weak match', () => {
    const found = identifySpeakers([{ speakerId: 'mic:0', embedding: weak, ownTrack: true }], [me])
    expect(found.get('mic:0')?.profile.name).toBe('Я')
  })

  it('stays strict on the track of the other side', () => {
    const found = identifySpeakers([{ speakerId: 'remote:0', embedding: weak, ownTrack: false }], [me])
    expect(found.size).toBe(0)
  })

  it('does not fill in somebody else\'s name on a weak match', () => {
    // Signing somebody else's utterance with a colleague's name is worse than leaving "Speaker 1".
    const found = identifySpeakers([{ speakerId: 'mic:0', embedding: weak, ownTrack: true }], [other])
    expect(found.size).toBe(0)
  })

  it('a strong match works on any track', () => {
    const found = identifySpeakers([{ speakerId: 'remote:0', embedding: strong, ownTrack: false }], [other])
    expect(found.get('remote:0')?.profile.name).toBe('Мария')
  })

  it('somebody else\'s print does not go to two participants', () => {
    // Two similar voices in one conversation are different people, and one name for
    // both would be a lie. Your own speech is another matter, and that is checked below.
    const found = identifySpeakers(
      [
        { speakerId: 'system:0', embedding: strong, ownTrack: false },
        { speakerId: 'system:1', embedding: [0.7, 0.714, 0], ownTrack: false }
      ],
      [other]
    )
    expect(found.size).toBe(1)
    expect(found.has('system:0')).toBe(true)
  })
})

/**
 * Your own voice on your own track is the exception to the "one print per
 * cluster" rule. On a real recording separation broke the person's speech into
 * two clusters: the first scored 0.692 and took the print, the second at 0.502
 * stayed nameless and appeared in the list as a separate participant, "In the
 * room 6".
 */
describe('your own voice in several clusters', () => {
  const like = (score: number): number[] => [score, Math.sqrt(1 - score * score), 0, 0]
  const me: VoiceProfile = {
    id: 'p1',
    name: 'Вы',
    isMe: true,
    embedding: [1, 0, 0, 0],
    createdAt: '2026-08-28T10:00:00.000Z',
    updatedAt: '2026-08-28T10:00:00.000Z',
    samples: 1
  }

  it('both clusters of your own track get one name', () => {
    const matches = identifySpeakers(
      [
        { speakerId: 'mic:0', embedding: like(0.692), ownTrack: true },
        { speakerId: 'mic:5', embedding: like(0.502), ownTrack: true }
      ],
      [me]
    )
    expect(matches.get('mic:0')?.profile.name).toBe('Вы')
    expect(matches.get('mic:5')?.profile.name).toBe('Вы')
  })

  it('somebody else\'s voice on your track gets no name', () => {
    const matches = identifySpeakers(
      [{ speakerId: 'mic:1', embedding: like(0.39), ownTrack: true }],
      [me]
    )
    expect(matches.size).toBe(0)
  })

  it('on the track of the other side your print goes to one cluster', () => {
    const other: VoiceProfile = { ...me, id: 'p2', name: 'Мария', isMe: false }
    const matches = identifySpeakers(
      [
        { speakerId: 'system:0', embedding: like(0.8), ownTrack: false },
        { speakerId: 'system:1', embedding: like(0.7), ownTrack: false }
      ],
      [other]
    )
    expect(matches.size).toBe(1)
    expect(matches.get('system:0')?.profile.name).toBe('Мария')
  })
})
