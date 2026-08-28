import type { SpylyApi } from './index.js'

declare global {
  interface Window {
    spyly: SpylyApi
  }
}

export {}
