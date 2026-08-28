import { describe, expect, it } from 'vitest'
import { identifySpeakers } from '../src/voice.js'
import type { VoiceProfile } from '../src/types.js'

/**
 * Свой голос на своей же дорожке узнаём мягче: спутать там не с кем, а не
 * узнать себя легко — на коротких репликах слепок шумный. На настоящей записи
 * собственный голос набирал 0.52 при общем пороге 0.62 и оставался «В комнате 1».
 */
describe('узнавание по голосу', () => {
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

  // Похожесть около 0.52 — как на настоящей записи.
  const weak = [0.52, 0.854, 0]
  const strong = [0.95, 0.312, 0]

  it('узнаёт себя на микрофонной дорожке при слабом совпадении', () => {
    const found = identifySpeakers([{ speakerId: 'mic:0', embedding: weak, ownTrack: true }], [me])
    expect(found.get('mic:0')?.profile.name).toBe('Я')
  })

  it('на дорожке собеседников остаётся строгим', () => {
    const found = identifySpeakers([{ speakerId: 'remote:0', embedding: weak, ownTrack: false }], [me])
    expect(found.size).toBe(0)
  })

  it('чужое имя по слабому совпадению не подставляет', () => {
    // Подписать чужую реплику именем коллеги хуже, чем оставить «Участник 1».
    const found = identifySpeakers([{ speakerId: 'mic:0', embedding: weak, ownTrack: true }], [other])
    expect(found.size).toBe(0)
  })

  it('сильное совпадение работает на любой дорожке', () => {
    const found = identifySpeakers([{ speakerId: 'remote:0', embedding: strong, ownTrack: false }], [other])
    expect(found.get('remote:0')?.profile.name).toBe('Мария')
  })

  it('чужой слепок не достаётся двум участникам', () => {
    // Два похожих голоса в одном разговоре — разные люди, и одно имя на двоих
    // было бы враньём. Своя речь — другое дело, это проверяется ниже.
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
 * Свой голос на своей дорожке — исключение из правила «один слепок на один
 * кластер». На настоящей записи разделение разбило речь человека на два
 * кластера: первый набрал 0.692 и забрал слепок, второй с 0.502 остался
 * безымянным и появился в списке отдельным участником «В комнате 6».
 */
describe('свой голос в нескольких кластерах', () => {
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

  it('оба кластера своей дорожки получают одно имя', () => {
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

  it('чужой голос на своей дорожке имя не получает', () => {
    const matches = identifySpeakers(
      [{ speakerId: 'mic:1', embedding: like(0.39), ownTrack: true }],
      [me]
    )
    expect(matches.size).toBe(0)
  })

  it('на дорожке собеседников свой слепок достаётся одному кластеру', () => {
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
