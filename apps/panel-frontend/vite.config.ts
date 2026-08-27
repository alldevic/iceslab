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
    // Measured, not guessed. The slowest cases here drive a Mantine form
    // through `userEvent`, which yields to the event loop between keystrokes:
    // in isolation the worst is 2.1s. Run inside the whole suite, where vitest
    // mounts thirty-seven screens across files in parallel, the same case
    // crossed the 5s default and reported a timeout — a different one on each
    // run, which is the signature of contention rather than of a defect. 15s is
    // ~7x the measured worst case; it still fails a test that has actually
    // hung, it just stops the result depending on what else the machine is
    // doing.
    testTimeout: 15_000,
  },
})
