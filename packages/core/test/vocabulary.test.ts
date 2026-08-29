import { describe, expect, it } from 'vitest'
import { learnedTerms } from '../src/vocabulary.js'

describe('learnedTerms', () => {
  it('catches a Latin term in place of a mis-heard Cyrillic one', () => {
    expect(learnedTerms('давай поднимем кубернетес', 'давай поднимем Kubernetes')).toEqual(['Kubernetes'])
  })

  it('does not suggest ordinary lower-case words', () => {
    expect(learnedTerms('он сказал что придет', 'он сказал что приедет завтра')).toEqual([])
  })

  it('sees names and versions', () => {
    expect(learnedTerms('поговори с ней про версию', 'поговори с Машей про Postgres 16.2')).toEqual([
      'Машей',
      'Postgres',
      '16.2'
    ])
  })

  // Otherwise a capital letter at the start of a sentence would look like a new
  // term every time.
  it('a change of case does not count as a term', () => {
    expect(learnedTerms('потом посмотрим', 'Потом посмотрим')).toEqual([])
  })

  it('does not repeat what is already in the dictionary', () => {
    expect(learnedTerms('сервис', 'сервис Kubernetes', ['kubernetes'])).toEqual([])
  })

  it('ignores words that were there before the edit', () => {
    expect(learnedTerms('Kubernetes падает', 'Kubernetes упал')).toEqual([])
  })

  it('does not count something too short as a term', () => {
    expect(learnedTerms('это', 'это АБ')).toEqual([])
  })
})
