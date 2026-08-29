import { defineConfig } from 'vitest/config'

/**
 * Tests do not live in the core alone: the window has pure functions of its own,
 * date captions for instance, and those have to be checked too. This was not
 * looked at before, and infinite recursion in the locale helper reached the screen.
 */
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/desktop/test/**/*.test.ts'],
    environment: 'node'
  }
})
