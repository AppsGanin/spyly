import type { Speaker, VoiceProfile } from './types.js'

/** Cosine closeness. Vectors of different lengths cannot be compared: those are different models. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** The average of several prints: the more confirmations, the steadier the profile. */
export function averageEmbedding(vectors: readonly (readonly number[])[]): number[] {
  const usable = vectors.filter((v) => v.length > 0)
  const first = usable[0]
  if (!first) return []
  const dim = first.length
  const out = new Array<number>(dim).fill(0)
  let n = 0
  for (const v of usable) {
    if (v.length !== dim) continue
    for (let i = 0; i < dim; i++) out[i] = out[i]! + v[i]!
    n++
  }
  if (n === 0) return []
  for (let i = 0; i < dim; i++) out[i] = out[i]! / n
  return out
}

/** The threshold below which no name is filled in: "Speaker 2" beats somebody else's name. */
export const VOICE_MATCH_THRESHOLD = 0.62

/**
 * The threshold for your own voice on your own track.
 *
 * Deliberately below the general one. Mistaking a stranger for you here is
 * almost impossible: you are the one at this computer, the microphone is
 * yours, and there is one print in the registry. Failing to recognise yourself,
 * on the other hand, is easy: on short utterances the print is noisy, and a
 * recording of the owner scored 0.52 against a threshold of 0.62.
 *
 * For other people's names the threshold stays strict: signing somebody else's
 * utterance with your name is far worse than leaving "In the room 1".
 */
export const OWN_VOICE_MATCH_THRESHOLD = 0.42

export interface VoiceMatch {
  profile: VoiceProfile
  score: number
}


/**
 * Fill in speaker names with matches from the registry.
 *
 * One profile cannot go to two clusters at once: the pairs with the highest
 * confidence are taken first, and each profile is claimed once. Otherwise two
 * similar voices in one call would get the same name.
 */
export function identifySpeakers(
  clusters: readonly { speakerId: string; embedding: readonly number[]; ownTrack?: boolean }[],
  profiles: readonly VoiceProfile[],
  threshold = VOICE_MATCH_THRESHOLD
): Map<string, VoiceMatch> {
  const pairs: { speakerId: string; profile: VoiceProfile; score: number }[] = []
  for (const c of clusters) {
    for (const p of profiles) {
      const score = cosineSimilarity(c.embedding, p.embedding)
      // Recognising yourself on your own track is gentler: there is nobody to confuse you with.
      const limit = p.isMe && c.ownTrack ? OWN_VOICE_MATCH_THRESHOLD : threshold
      if (score >= limit) pairs.push({ speakerId: c.speakerId, profile: p, score })
    }
  }
  pairs.sort((a, b) => b.score - a.score)

  const takenSpeakers = new Set<string>()
  const takenProfiles = new Set<string>()
  const out = new Map<string, VoiceMatch>()
  for (const pair of pairs) {
    if (takenSpeakers.has(pair.speakerId)) continue
    // Your own voice on your own track is the exception to the "one profile per
    // cluster" rule. There is one person, and voice separation may well break their
    // speech into several clusters: part said louder, part over the other side. On
    // a real recording the second cluster scored 0.502 against a threshold of 0.42
    // and still stayed nameless, because the first had already taken the profile.
    // Two different people still cannot end up with one name this way.
    const own = pair.profile.isMe && clusters.find((c) => c.speakerId === pair.speakerId)?.ownTrack
    if (!own && takenProfiles.has(pair.profile.id)) continue
    takenSpeakers.add(pair.speakerId)
    takenProfiles.add(pair.profile.id)
    out.set(pair.speakerId, { profile: pair.profile, score: pair.score })
  }
  return out
}

/** Apply the matches that were found to the list of speakers. */
export function applyIdentification(speakers: readonly Speaker[], matches: Map<string, VoiceMatch>): Speaker[] {
  return speakers.map((s) => {
    const m = matches.get(s.id)
    if (!m) return s
    return { ...s, name: m.profile.name, isMe: m.profile.isMe, nameSource: 'voice-match' as const, matchScore: m.score }
  })
}
