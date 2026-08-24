import { defineConfig, devices } from '@playwright/test';

/**
 * Layer 3: the panel driven in a real browser against a real backend and a real
 * database. What it is here to catch is the class neither types nor jsdom can
 * see - a route that 404s, an auth token that never reaches the second request,
 * a form the server rejects for a reason the client never mirrored.
 *
 * It does NOT start the stack. The lab owns the dev servers (see
 * /var/tmp/iceslab-vmlab/README.lab); starting a second pair here would fight
 * it for ports 3000/5173 and for the `iceslab_a2dev` database. `globalSetup`
 * fails with an explanation instead of a timeout when they are down.
 */
const FRONTEND = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  // One browser at a time, deliberately. This box also runs the lab's qemu
  // guests (~1.5 GB each) with no swap, and a parallel worker pool is the
  // easiest way to turn a test run into an OOM.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  // On disk, NOT under /tmp: /tmp is tmpfs here, so traces and screenshots
  // would be charged to the same RAM the browser is already using.
  outputDir: './.playwright',
  use: {
    baseURL: FRONTEND,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Video is the expensive artefact and it buffers in memory while it runs.
    video: 'off',
  },
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/, use: { ...devices['Desktop Chrome'], channel: 'chromium-headless-shell' } },
    {
      name: 'chromium',
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        // headless-shell is the smaller of the two chromium builds Playwright
        // ships, and nothing here needs a headed browser's extra surface.
        channel: 'chromium-headless-shell',
        // Every spec starts signed in; login.spec.ts opts out explicitly.
        storageState: './.playwright/auth.json',
      },
    },
  ],
});
