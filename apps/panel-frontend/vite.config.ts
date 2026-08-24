import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Pull version from package.json at build time so the UI never lies about it.
// Match the parent monorepo's tagging: bump pkg.version when tagging Iceslab,
// the panel reflects it automatically on next build.
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')) as {
  version: string
}

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    // jsdom for every file, not just the component ones: the locale tests read
    // the source tree through node:fs and that keeps working, while a per-file
    // docblock would be one more thing to remember on each new test.
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // Test helpers are not tests; without this vitest would collect
    // src/test/setup.ts as a suite with no cases and fail the run.
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
})
