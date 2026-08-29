import { build } from 'esbuild'

/**
 * Building the server into a single file.
 *
 * A packaged application has no node_modules, so the dependencies, both
 * @spyly/core and the MCP SDK, are bundled inside.
 */
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/bundle.mjs',
  banner: {
    // The MCP SDK uses CommonJS-compatible paths in places.
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
  },
  logLevel: 'warning'
})
console.log('mcp-server built into dist/bundle.mjs')
