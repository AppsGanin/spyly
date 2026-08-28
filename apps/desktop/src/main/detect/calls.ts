import { t } from '@spyly/core'
import { Notification } from 'electron'
import { listApps, micStatus } from '../audio/native.js'

/**
 * Замечает начало созвона.
 *
 * Главный признак — микрофон занят другим приложением: только он ловит
 * браузерные созвоны (Meet, Телемост в Chrome), где имя процесса ничего не
 * говорит. Список приложений идёт вторым признаком, потому что на macOS
 * Bluetooth-гарнитуры стабильно сообщают, что не используются.
 */

const CALL_APPS = [
  'zoom',
  'telemost',
  'телемост',
  'skype',
  'teams',
  'webex',
  'discord',
  'slack',
  'telegram',
  'whatsapp',
  'facetime',
  'meet',
  'jitsi',
  'talk',
  'контур'
]

const POLL_MS = 5000
/** Столько подряд опросов должны говорить «созвон», прежде чем поверим. */
const CONFIRMATIONS = 2
/** После отказа не пристаём заново хотя бы столько времени. */
const SNOOZE_MS = 10 * 60 * 1000

export interface CallDetectorOptions {
  mode: () => 'off' | 'notify' | 'auto'
  isRecording: () => boolean
  onDetected: (info: { app: string; auto: boolean }) => void
}

let timer: NodeJS.Timeout | null = null
let hits = 0
let snoozedUntil = 0
let lastNotifiedApp = ''

function looksLikeCallApp(name: string): boolean {
  const lower = name.toLowerCase()
  return CALL_APPS.some((needle) => lower.includes(needle))
}

async function probe(options: CallDetectorOptions): Promise<void> {
  if (options.mode() === 'off' || options.isRecording() || Date.now() < snoozedUntil) {
    hits = 0
    return
  }

  const status = await micStatus()
  if (!status.busy) {
    hits = 0
    return
  }

  // Пытаемся назвать приложение: сначала по тому, кто держит микрофон,
  // потом по тому, кто сейчас звучит.
  let app = status.apps.find(looksLikeCallApp) ?? status.apps[0] ?? ''
  if (!app) {
    const playing = await listApps()
    app = playing.find((a) => a.isPlaying && looksLikeCallApp(a.name))?.name ?? playing.find((a) => a.isPlaying)?.name ?? ''
  }

  hits++
  if (hits < CONFIRMATIONS) return
  hits = 0

  const auto = options.mode() === 'auto'
  const label = app ?? ''
  if (!auto) {
    // Одно уведомление на приложение: повторные только раздражают.
    if (lastNotifiedApp === label && Date.now() < snoozedUntil) return
    lastNotifiedApp = label
    snoozedUntil = Date.now() + SNOOZE_MS
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: t('Похоже, начался созвон'),
        body: t('{label} слушает микрофон. Записать разговор?', { label: label }),
        actions: [{ type: 'button', text: t('Записать') }]
      })
      notification.on('action', () => options.onDetected({ app: label, auto: false }))
      notification.on('click', () => options.onDetected({ app: label, auto: false }))
      notification.show()
    }
  }
  options.onDetected({ app: label, auto })
}

export function startCallDetector(options: CallDetectorOptions): void {
  stopCallDetector()
  timer = setInterval(() => void probe(options).catch(() => undefined), POLL_MS)
  timer.unref?.()
}

export function stopCallDetector(): void {
  if (timer) clearInterval(timer)
  timer = null
  hits = 0
}

/** «Не сейчас» — не спрашивать какое-то время. */
export function snoozeDetection(minutes = 10): void {
  snoozedUntil = Date.now() + minutes * 60_000
}
