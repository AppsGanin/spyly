import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Menu, Tray, app, nativeImage } from 'electron'
import { t, humanDuration } from '@spyly/core'
import type { RecordingState } from '../shared/ipc.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

let tray: Tray | null = null
let lastState: RecordingState | null = null

/** Хендлеры ставит слой IPC — трей не должен знать о записи ничего лишнего. */
export const trayActions: {
  onToggleRecording?: () => void
  onShowWindow?: () => void
} = {}

function iconPath(recording: boolean): string {
  const name = recording ? 'trayRecordingTemplate.png' : 'trayTemplate.png'
  return app.isPackaged
    ? path.join(process.resourcesPath, 'tray', name)
    : path.join(dirname, '../../resources', name)
}

function buildMenu(state: RecordingState | null): Menu {
  const recording = state?.status === 'recording' || state?.status === 'paused'
  return Menu.buildFromTemplate([
    {
      label: recording ? `Идёт запись · ${humanDuration(state?.elapsedSec ?? 0)}` : t('Запись не идёт'),
      enabled: false
    },
    { type: 'separator' },
    {
      label: recording ? t('Остановить запись') : t('Начать запись'),
      click: () => trayActions.onToggleRecording?.()
    },
    { label: t('Открыть Spyly'), click: () => trayActions.onShowWindow?.() },
    { type: 'separator' },
    { label: t('Выйти'), role: 'quit' }
  ])
}

export function createTray(): void {
  if (tray) return
  const image = nativeImage.createFromPath(iconPath(false))
  image.setTemplateImage(true)
  tray = new Tray(image)
  tray.setToolTip('Spyly')
  tray.setContextMenu(buildMenu(null))
  tray.on('click', () => trayActions.onShowWindow?.())
}

/** Иконка меняется на залитую во время записи — приложение не должно быть незаметным. */
export function updateTray(state: RecordingState): void {
  lastState = state
  if (!tray) return
  const recording = state.status === 'recording' || state.status === 'paused'
  const image = nativeImage.createFromPath(iconPath(recording))
  image.setTemplateImage(true)
  tray.setImage(image)
  tray.setToolTip(recording ? `Spyly · запись ${humanDuration(state.elapsedSec)}` : 'Spyly')
  tray.setContextMenu(buildMenu(state))
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
  lastState = null
}

export function currentTrayState(): RecordingState | null {
  return lastState
}
