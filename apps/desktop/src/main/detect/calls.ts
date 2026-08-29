import { t } from '@spyly/core'
import { Notification } from 'electron'
import { listApps, micStatus } from '../audio/native.js'

/**
 * Notices a call starting.
 *
 * The main sign is another application holding the microphone: only that
 * catches browser calls (Meet, Telemost in Chrome), where the process name
 * says nothing. The application list comes second, because on macOS Bluetooth
 * headsets reliably report that they are not in use.
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
/** This many polls in a row have to say "a call" before we believe it. */
const CONFIRMATIONS = 2
/** After a refusal, do not ask again for at least this long. */
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

  // Try to name the application: first by who holds the microphone, then by who
  // is currently making sound.
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
    // One notification per application: repeats only annoy.
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

/** "Not now" means not asking again for a while. */
export function snoozeDetection(minutes = 10): void {
  snoozedUntil = Date.now() + minutes * 60_000
}
