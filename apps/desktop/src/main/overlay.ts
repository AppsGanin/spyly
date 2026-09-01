import path from 'node:path'
import { BrowserWindow, screen } from 'electron'

/**
 * The floating panel above every window.
 *
 * It only lives while recording. Frameless, above every window and on every
 * desktop: otherwise, switching to the browser with the call in it, a person
 * would lose the panel, and that is exactly where it is needed.
 *
 * It is two windows, not one. A single window wide enough for the draft is
 * mostly empty next to the pill, and a transparent window still swallows
 * clicks — so the empty part had to be let through, and deciding where the
 * cursor was left the stop button dead more than once. Two windows, each the
 * size of what it draws, need none of that: the pill takes clicks always,
 * because there is no empty space in it to take them by mistake.
 */
let pill: BrowserWindow | null = null
let draft: BrowserWindow | null = null

const PILL_WIDTH = 236
const PILL_HEIGHT = 44

/** The draft is wider than the pill and hangs under it, aligned to the same right edge. */
const DRAFT_WIDTH = 460
const DRAFT_HEIGHT = 124
const GAP = 8

const MARGIN = 20

function common(dirname: string): Electron.BrowserWindowConstructorOptions {
  return {
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    // We do not steal focus: the panel appears over a call, and pulling focus out
    // of it at the moment a conversation starts is the worst thing to do.
    focusable: false,
    webPreferences: {
      preload: path.join(dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // No spell checker: a transcript is speech as it was said, and squiggles
      // under half of it say nothing — there is nothing to correct here, and
      // they only make the text harder to read.
      spellcheck: false
    }
  }
}

function load(win: BrowserWindow, dirname: string, hash: string): void {
  const url = process.env.ELECTRON_RENDERER_URL
  if (url) void win.loadURL(`${url}#${hash}`)
  else void win.loadFile(path.join(dirname, '../renderer/index.html'), { hash })
}

export function showOverlay(dirname: string): void {
  if (pill && !pill.isDestroyed()) {
    pill.showInactive()
    return
  }

  const { workArea } = screen.getPrimaryDisplay()
  pill = new BrowserWindow({
    ...common(dirname),
    width: PILL_WIDTH,
    height: PILL_HEIGHT,
    // Top right corner: it is least in the way there, and it matches the usual
    // place for a recording indicator in the system.
    x: workArea.x + workArea.width - PILL_WIDTH - MARGIN,
    y: workArea.y + MARGIN,
    movable: true
  })

  pill.setAlwaysOnTop(true, 'screen-saver')
  pill.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  load(pill, dirname, 'overlay')

  pill.once('ready-to-show', () => pill?.showInactive())
  // The draft hangs off the pill, so it goes wherever the pill is dragged.
  pill.on('move', () => placeDraft())
  pill.on('closed', () => {
    pill = null
    closeDraft()
  })
}

export function hideOverlay(): void {
  closeDraft()
  if (pill && !pill.isDestroyed()) pill.close()
  pill = null
}

/** The panel receives events just like the main window. */
export function overlayWindow(): BrowserWindow | null {
  return pill && !pill.isDestroyed() ? pill : null
}

/** The draft window, when it is up: events for the live text go to it. */
export function overlayDraftWindow(): BrowserWindow | null {
  return draft && !draft.isDestroyed() ? draft : null
}

/**
 * Show or hide the box with the live text under the pill.
 *
 * Its own window, so that the space beside the pill stays free: there is
 * nothing of ours there and a click belongs to whatever is underneath.
 */
export function setOverlayDraft(visible: boolean, dirname?: string): void {
  if (!visible) return closeDraft()
  if (draft && !draft.isDestroyed()) return placeDraft()
  const owner = overlayWindow()
  if (!owner || !dirname) return

  draft = new BrowserWindow({
    ...common(dirname),
    width: DRAFT_WIDTH,
    height: DRAFT_HEIGHT,
    movable: false
  })
  draft.setAlwaysOnTop(true, 'screen-saver')
  draft.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Nothing in it is pressed, and it lies over somebody's call: every click
  // goes straight through to what is underneath.
  draft.setIgnoreMouseEvents(true)
  load(draft, dirname, 'overlay-draft')
  placeDraft()
  draft.once('ready-to-show', () => draft?.showInactive())
  draft.on('closed', () => {
    draft = null
  })
}

function placeDraft(): void {
  const owner = overlayWindow()
  const win = overlayDraftWindow()
  if (!owner || !win) return
  const at = owner.getBounds()
  win.setBounds({
    // The same right edge as the pill: the two read as one panel.
    x: at.x + at.width - DRAFT_WIDTH,
    y: at.y + at.height + GAP,
    width: DRAFT_WIDTH,
    height: DRAFT_HEIGHT
  })
}

function closeDraft(): void {
  if (draft && !draft.isDestroyed()) draft.close()
  draft = null
}
