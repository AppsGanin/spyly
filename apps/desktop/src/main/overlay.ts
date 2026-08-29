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
