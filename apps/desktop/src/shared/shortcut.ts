/**
 * The shortcut for starting and stopping a recording, shared by the main
 * process that registers it and the window that lets a person change it.
 *
 * Stored as an Electron accelerator: that is what `globalShortcut` takes, and
 * a caption is always derived from it rather than kept alongside.
 */

/**
 * The shortcut a recording starts with until a person picks their own.
 *
 * Not ⌘⇧R: that reloads a page past the cache in every browser, and a global
 * shortcut swallows it everywhere, the call tab included. ⌃⌘R is taken by
 * neither the system nor the browsers. Elsewhere there is no ⌘, and
 * `Control+Command+R` would come out as plain Ctrl+R, the same reload.
 */
export function defaultRecordShortcut(mac: boolean): string {
  return mac ? 'Control+Command+R' : 'Control+Alt+Shift+R'
}

export interface KeyPress {
  /** The physical key, as in `KeyboardEvent.code`. */
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/**
 * Accelerator names for the keys that are not a letter or a digit.
 *
 * By `code`, not `key`: with ⌥ held `key` is "®" instead of "R", and on a
 * Russian layout it is "к". The physical key is also what the system
 * shortcut listens to.
 */
const NAMED: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`'
}

function keyName(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code
  return NAMED[code] ?? null
}

/**
 * The accelerator for a key press, or null when it cannot be one.
 *
 * Null while only modifiers are held, and for a plain key or one with ⇧ alone:
 * a global shortcut takes the key away from every application, and "R" or
 * "⇧R" would stop a person typing. Function keys are the exception, nobody
 * types with them.
 */
export function acceleratorFromKey(press: KeyPress, mac: boolean): string | null {
  const key = keyName(press.code)
  if (!key) return null

  const modifiers: string[] = []
  if (press.ctrlKey) modifiers.push('Control')
  if (press.altKey) modifiers.push('Alt')
  if (press.shiftKey) modifiers.push('Shift')
  if (press.metaKey) modifiers.push(mac ? 'Command' : 'Super')

  const functionKey = /^F\d+$/.test(key)
  if (!functionKey && !(press.ctrlKey || press.altKey || press.metaKey)) return null
  return [...modifiers, key].join('+')
}

const MAC_KEYS: Record<string, string> = {
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Enter: '↩',
  Return: '↩',
  Tab: '⇥',
  Backspace: '⌫',
  Delete: '⌦',
  Escape: '⎋',
  Esc: '⎋'
}

/** How a shortcut is written on screen: ⌃⌘R on a Mac, Ctrl+Alt+Shift+R elsewhere. */
export function shortcutLabel(accelerator: string, mac: boolean): string {
  let control = false
  let alt = false
  let shift = false
  let command = false
  let key = ''

  for (const part of accelerator.split('+')) {
    switch (part.toLowerCase()) {
      case 'commandorcontrol':
      case 'cmdorctrl':
        if (mac) command = true
        else control = true
        break
      case 'command':
      case 'cmd':
      case 'super':
      case 'meta':
        command = true
        break
      case 'control':
      case 'ctrl':
        control = true
        break
      case 'alt':
      case 'option':
        alt = true
        break
      case 'shift':
        shift = true
        break
      default:
        key = part === 'Plus' ? '+' : part
    }
  }

  if (mac) {
    // Apple's order, the one every menu in the system uses.
    return `${control ? '⌃' : ''}${alt ? '⌥' : ''}${shift ? '⇧' : ''}${command ? '⌘' : ''}${MAC_KEYS[key] ?? key}`
  }
  return [control && 'Ctrl', alt && 'Alt', shift && 'Shift', command && 'Win', key].filter(Boolean).join('+')
}
