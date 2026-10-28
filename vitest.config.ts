import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '~~': fileURLToPath(new URL('.', import.meta.url)),
      // Match Vite's browser ESM entry instead of the package's CommonJS main.
      'three-bvh-csg': fileURLToPath(new URL('./node_modules/three-bvh-csg/src/index.js', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    server: { deps: { inline: ['three-bvh-csg', 'three-mesh-bvh'] } },
  },
})
