import { describe, expect, it } from 'vitest'
import { acceleratorFromKey, defaultRecordShortcut, shortcutLabel } from '../src/shared/shortcut'

const press = (code: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods
})

describe('the recording shortcut', () => {
  it('is not ⌘⇧R by default: that reloads a page in every browser', () => {
    expect(shortcutLabel(defaultRecordShortcut(true), true)).toBe('⌃⌘R')
  })

  it('does not turn into Ctrl+R where there is no ⌘', () => {
    expect(shortcutLabel(defaultRecordShortcut(false), false)).toBe('Ctrl+Alt+Shift+R')
  })

  it('takes the physical key: with ⌥ held, or on a Russian layout, the letter is not R', () => {
    expect(acceleratorFromKey(press('KeyR', { metaKey: true, altKey: true, shiftKey: true }), true)).toBe(
      'Alt+Shift+Command+R'
    )
    expect(acceleratorFromKey(press('Digit5', { ctrlKey: true }), false)).toBe('Control+5')
    expect(acceleratorFromKey(press('ArrowUp', { metaKey: true }), false)).toBe('Super+Up')
  })

  it('refuses a combination that would stop a person typing', () => {
    expect(acceleratorFromKey(press('KeyR'), true)).toBeNull()
    expect(acceleratorFromKey(press('KeyR', { shiftKey: true }), true)).toBeNull()
    expect(acceleratorFromKey(press('F5'), true)).toBe('F5')
  })

  it('waits while only modifiers are held', () => {
    expect(acceleratorFromKey(press('MetaLeft', { metaKey: true }), true)).toBeNull()
    expect(acceleratorFromKey(press('ShiftRight', { shiftKey: true, altKey: true }), true)).toBeNull()
  })

  it('reads back what it recorded, in the order menus use', () => {
    const recorded = acceleratorFromKey(press('Space', { ctrlKey: true, metaKey: true }), true)!
    expect(shortcutLabel(recorded, true)).toBe('⌃⌘Space')
    expect(shortcutLabel('Control+Alt+Up', true)).toBe('⌃⌥↑')
  })
})
