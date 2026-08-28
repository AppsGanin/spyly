import path from 'node:path'
import { BrowserWindow, screen } from 'electron'

/**
 * Окно плавающей панели.
 *
 * Живёт только во время записи. Frameless, поверх всех окон и на всех рабочих
 * столах: иначе, переключившись на браузер с созвоном, человек панель потеряет
 * — а нужна она именно там.
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
    // Правый верхний угол: там меньше всего мешает и совпадает с привычным
    // местом индикатора записи в системе.
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
    // Не крадём фокус: панель появляется поверх созвона, и увести фокус из
    // него в момент начала разговора — худшее, что можно сделать.
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

/** Панель — такой же получатель событий, как главное окно. */
export function overlayWindow(): BrowserWindow | null {
  return overlay && !overlay.isDestroyed() ? overlay : null
}
