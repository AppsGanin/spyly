import path from 'node:path'
import { BrowserWindow, screen } from 'electron'

/**
 * The floating panel window.
 *
 * It only lives while recording. Frameless, above every window and on every
 * desktop: otherwise, switching to the browser with the call in it, a person
 * would lose the panel, and that is exactly where it is needed.
 */
let overlay: BrowserWindow | null = null

const WIDTH = 236
const HEIGHT = 44

/**
 * The panel grows when there is a draft to show.
 *
 * It is not made tall in advance: the window is transparent, but a transparent
 * window still swallows clicks, and an empty strip under the pill would sit on
 * top of whatever the person is actually working in.
 */
const WIDE = 420
const TALL = 92

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
    // place for a recording indicator in the system.
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
      sandbox: false
    }
  })

  overlay.setAlwaysOnTop(true, 'screen-saver')
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  const url = process.env.ELECTRON_RENDERER_URL
  if (url) void overlay.loadURL(`${url}#overlay`)
  else void overlay.loadFile(path.join(dirname, '../renderer/index.html'), { hash: 'overlay' })

  overlay.once('ready-to-show', () => overlay?.showInactive())
  overlay.on('closed', () => {
    overlay = null
  })
}

export function hideOverlay(): void {
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
  const width = visible ? WIDE : WIDTH
  const height = visible ? TALL : HEIGHT
  const bounds = win.getBounds()
  if (bounds.width === width && bounds.height === height) return
  win.setBounds({
    x: bounds.x + bounds.width - width,
    y: bounds.y,
    width,
    height
  })
}
