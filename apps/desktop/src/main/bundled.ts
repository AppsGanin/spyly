import { existsSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

/**
 * Where a binary we ship ourselves lies.
 *
 * Packaged, everything is in `Resources/bin`. In development each one is
 * wherever its own build put it, and the application may be started from the
 * repository root or from inside `apps/desktop`, so both are tried.
 *
 * This used to be written out in four places, each with its own order of
 * candidates, which is how the audio helper came to be looked for differently
 * depending on who was asking.
 */
export function bundledBinary(name: string, ...devDir: string[]): string {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'bin', name)]
    : [
        path.join(process.cwd(), ...devDir, name),
        path.join(app.getAppPath(), '..', '..', ...devDir, name)
      ]
  return candidates.find(existsSync) ?? candidates[0]!
}

/** The audio and calendar helper: CoreAudio and EventKit are not reachable from Node. */
export function audioHelper(): string {
  return bundledBinary('spyly-audiotap', 'native', 'macos-audio', '.build', 'release')
}

/** whisper.cpp: `whisper-cli` transcribes a file, `whisper-server` holds the model in memory. */
export function whisperBinary(name: 'whisper-cli' | 'whisper-server'): string {
  return bundledBinary(name, 'native', 'whisper', 'build', 'bin')
}
