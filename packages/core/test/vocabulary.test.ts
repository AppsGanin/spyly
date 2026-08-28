import { describe, expect, it } from 'vitest'
import { learnedTerms } from '../src/vocabulary.js'

describe('learnedTerms', () => {
  it('ловит латинский термин вместо расслышанной кириллицы', () => {
    expect(learnedTerms('давай поднимем кубернетес', 'давай поднимем Kubernetes')).toEqual(['Kubernetes'])
  })

  it('не предлагает обычные строчные слова', () => {
    expect(learnedTerms('он сказал что придет', 'он сказал что приедет завтра')).toEqual([])
  })

  it('видит имена и версии', () => {
    expect(learnedTerms('поговори с ней про версию', 'поговори с Машей про Postgres 16.2')).toEqual([
      'Машей',
      'Postgres',
      '16.2'
    ])
  })

  // Иначе заглавная буква в начале предложения каждый раз выглядела бы
  // как новый термин.
  it('правку регистра термином не считает', () => {
    expect(learnedTerms('потом посмотрим', 'Потом посмотрим')).toEqual([])
  })

  it('не повторяет то, что уже в словаре', () => {
    expect(learnedTerms('сервис', 'сервис Kubernetes', ['kubernetes'])).toEqual([])
  })

  it('игнорирует слова, которые были и до правки', () => {
    expect(learnedTerms('Kubernetes падает', 'Kubernetes упал')).toEqual([])
  })

  it('не считает термином слишком короткое', () => {
    expect(learnedTerms('это', 'это АБ')).toEqual([])
  })
})
