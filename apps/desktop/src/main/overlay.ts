import path from 'node:path'
import { BrowserWindow, screen } from 'electron'
import { PILL_HEIGHT, pointIsOnPanel } from './overlay-hit.js'

/**
 * The floating panel window.
 *
 * It only lives while recording. Frameless, above every window and on every
 * desktop: otherwise, switching to the browser with the call in it, a person
 * would lose the panel, and that is exactly where it is needed.
 */
let overlay: BrowserWindow | null = null

/**
 * The window is as wide as the draft from the outset.
 *
 * It used to be as narrow as the pill and widen leftwards when the text
 * appeared. That cost twice over: the box for the text visibly grew as one
 * read, and after the resize macOS went on hit-testing the buttons at their old
 * places, so the stop button stopped responding. The window keeps one width
 * now, and the empty part of it is let through to whatever is underneath.
 */
const WIDTH = 460
const HEIGHT = PILL_HEIGHT

/** Only the height changes: the pill stays at the top and does not move. */
const TALL = 168

/** How often the cursor is checked against what the panel actually draws. */
const CURSOR_CHECK_MS = 100

let cursorTimer: NodeJS.Timeout | null = null
let takingMouse = false

export function showOverlay(dirname: string): void {
  if (overlay && !overlay.isDestroyed()) {
    overlay.showInactive()
    return
  }

  const { workArea } = screen.getPrimaryDisplay()
  overlay = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    // Top right corner: it is least in the way there, and it matches the usual
    // place for a recording indicator in the system. The content inside is
    // pressed to the right edge, so the pill lands there whatever the width.
    x: workArea.x + workArea.width - WIDTH - 20,
    y: workArea.y + 20,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
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
  })

  overlay.setAlwaysOnTop(true, 'screen-saver')
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  const url = process.env.ELECTRON_RENDERER_URL
  if (url) void overlay.loadURL(`${url}#overlay`)
  else void overlay.loadFile(path.join(dirname, '../renderer/index.html'), { hash: 'overlay' })

  // Clicks pass through until the cursor comes to rest on something of ours.
  overlay.setIgnoreMouseEvents(true)
  watchCursor()

  overlay.once('ready-to-show', () => overlay?.showInactive())
  overlay.on('closed', () => {
    overlay = null
    stopWatchingCursor()
  })
}

export function hideOverlay(): void {
  stopWatchingCursor()
  if (overlay && !overlay.isDestroyed()) overlay.close()
  overlay = null
}

/** The panel receives events just like the main window. */
export function overlayWindow(): BrowserWindow | null {
  return overlay && !overlay.isDestroyed() ? overlay : null
}

/**
 * Make room for the draft, keeping the pill where it was.
 *
 * The panel is anchored to the right edge, so the window grows to the left and
 * downwards: the buttons stay under the cursor that was already reaching for them.
 */
export function setOverlayDraft(visible: boolean): void {
  const win = overlayWindow()
  if (!win) return
  const height = visible ? TALL : HEIGHT
  const bounds = win.getBounds()
  if (bounds.height === height) return
  win.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height })
}

/**
 * Whether the panel takes the mouse or lets it through.
 *
 * Most of the window is empty and transparent, and an invisible pane over
 * somebody's call would be worse than no panel at all. So clicks pass through
 * by default, and the panel takes them only while the cursor is over the pill
 * or over the text.
 *
 * Where the cursor is we work out ourselves rather than ask the window: a
 * window that ignores the mouse is not reliably told the mouse moved, and
 * getting that wrong would leave the stop button dead — which is the very thing
 * being fixed here.
 */
function watchCursor(): void {
  if (cursorTimer) return
  cursorTimer = setInterval(() => {
    const win = overlayWindow()
    if (!win) return stopWatchingCursor()
    const point = screen.getCursorScreenPoint()
    const over = pointIsOnPanel(win.getBounds(), point)
    if (over === takingMouse) return
    takingMouse = over
    win.setIgnoreMouseEvents(!over)
  }, CURSOR_CHECK_MS)
  cursorTimer.unref?.()
}

function stopWatchingCursor(): void {
  if (cursorTimer) clearInterval(cursorTimer)
  cursorTimer = null
  takingMouse = false
}


