import { describe, expect, it } from 'vitest'
import { describeUpdateError } from '../src/main/update-error'

/** Errors shaped the way electron-updater builds them: a message with everything glued in, and a code. */
function updaterError(message: string, code?: string, statusCode?: number): Error {
  return Object.assign(new Error(message), { code, statusCode })
}

describe('a failed update check', () => {
  it('is not a wall of headers when a release has no files yet', () => {
    const error = updaterError(
      'Cannot find latest-mac.yml in the latest release artifacts ' +
        '(https://github.com/AppsGanin/spyly/releases/download/v1.3.0/latest-mac.yml): ' +
        'HttpError: 404 "method: GET url: https://github.com/AppsGanin/spyly/releases/download/v1.3.0/latest-mac.yml\n\n' +
        'Please double check that your authentication token is correct." Headers: { "cache-control": "no-cache" }\n' +
        '    at createHttpError (httpExecutor.js:53:12)',
      'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
    )
    const problem = describeUpdateError(error)
    expect(problem.tone).toBe('info')
    expect(problem.text).toContain('1.3.0')
    expect(problem.text).not.toContain('Headers')
  })

  it('says the connection is gone, even wrapped as "latest version not found"', () => {
    const error = updaterError(
      'Unable to find latest version on GitHub (https://github.com/AppsGanin/spyly/releases/latest), ' +
        'please ensure a production release exists: Error: net::ERR_INTERNET_DISCONNECTED',
      'ERR_UPDATER_LATEST_VERSION_NOT_FOUND'
    )
    expect(describeUpdateError(error).text).toMatch(/Нет связи с GitHub/)
  })

  it('tells a rate limit and a GitHub outage apart from the rest', () => {
    expect(describeUpdateError(updaterError('HttpError: 403 rate limit exceeded')).text).toMatch(/ограничил/)
    expect(describeUpdateError(updaterError('HTTP error: Bad Gateway', 'HTTP_ERROR_502', 502)).text).toMatch(/не отвечает/)
  })

  it('never shows the raw text, whatever it was', () => {
    const problem = describeUpdateError(new Error('something nobody expected\n    at somewhere.js:1:1'))
    expect(problem.tone).toBe('error')
    expect(problem.text).not.toContain('somewhere.js')
  })
})
