import type { Speaker, VoiceProfile } from './types.js'

/** Косинусная близость. Векторы разной длины сравнивать нельзя — это разные модели. */
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

/** Среднее нескольких слепков — профиль тем устойчивее, чем больше подтверждений. */
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

/** Порог, ниже которого имя не подставляем: лучше «Участник 2», чем чужое имя. */
export const VOICE_MATCH_THRESHOLD = 0.62

/**
 * Порог для собственного голоса на своей же дорожке.
 *
 * Ниже общего намеренно. Спутать постороннего с вами тут почти невозможно: за
 * этим компьютером сидите вы, микрофон ваш, и слепок в реестре один. А вот не
 * узнать себя легко — на коротких репликах слепок шумный, и своя же запись
 * набирала 0.52 при пороге 0.62.
 *
 * Для чужих имён порог остаётся строгим: подписать чужую реплику вашим именем
 * куда неприятнее, чем оставить «В комнате 1».
 */
export const OWN_VOICE_MATCH_THRESHOLD = 0.42

export interface VoiceMatch {
  profile: VoiceProfile
  score: number
}


/**
 * Расставить именам спикеров совпадения из реестра.
 *
 * Один профиль не может достаться двум кластерам сразу: сначала берём пары с
 * наибольшей уверенностью, каждый профиль занимается один раз. Иначе два похожих
 * голоса в одном созвоне получили бы одно и то же имя.
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
      // Себя на своей дорожке узнаём мягче: спутать тут не с кем.
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
    // Свой голос на своей дорожке — исключение из правила «один профиль на
    // один кластер». Человек один, а разделение по голосам вполне может
    // разбить его речь на несколько кластеров: часть сказана громче, часть
    // поверх собеседника. На реальной записи второй кластер набрал 0.502 при
    // пороге 0.42 и всё равно остался безымянным — потому что профиль уже
    // забрал первый. Двум разным людям одно имя так по-прежнему не достаётся.
    const own = pair.profile.isMe && clusters.find((c) => c.speakerId === pair.speakerId)?.ownTrack
    if (!own && takenProfiles.has(pair.profile.id)) continue
    takenSpeakers.add(pair.speakerId)
    takenProfiles.add(pair.profile.id)
    out.set(pair.speakerId, { profile: pair.profile, score: pair.score })
  }
  return out
}

/** Применить найденные совпадения к списку спикеров. */
export function applyIdentification(speakers: readonly Speaker[], matches: Map<string, VoiceMatch>): Speaker[] {
  return speakers.map((s) => {
    const m = matches.get(s.id)
    if (!m) return s
    return { ...s, name: m.profile.name, isMe: m.profile.isMe, nameSource: 'voice-match' as const, matchScore: m.score }
  })
}
