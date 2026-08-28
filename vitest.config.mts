import { defineConfig } from 'vitest/config'

/**
 * Тесты живут не только в ядре: у окна есть свои чистые функции — подписи дат,
 * например, — и они тоже должны проверяться. Раньше сюда не заглядывали, и
 * бесконечная рекурсия в выборе локали дошла до экрана.
 */
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/desktop/test/**/*.test.ts'],
    environment: 'node'
  }
})
