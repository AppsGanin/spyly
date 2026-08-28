import { build } from 'esbuild'

/**
 * Сборка сервера в один файл.
 *
 * В упакованном приложении нет node_modules, поэтому зависимости —
 * и @spyly/core, и MCP SDK — вшиваются внутрь.
 */
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/bundle.mjs',
  banner: {
    // MCP SDK местами использует CommonJS-совместимые пути.
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
  },
  logLevel: 'warning'
})
console.log('mcp-server собран в dist/bundle.mjs')
