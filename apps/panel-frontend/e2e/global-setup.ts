import { request } from '@playwright/test';

const FRONTEND = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const BACKEND = process.env.E2E_API_URL ?? 'http://127.0.0.1:3000';

/**
 * Say which half of the stack is missing before a single test starts. Without
 * this, a panel that is simply not running shows up as every test failing on a
 * navigation timeout 60 seconds apart.
 */
export default async function globalSetup() {
  const ctx = await request.newContext({ ignoreHTTPSErrors: true });
  for (const [what, url] of [
    ['frontend', FRONTEND],
    ['backend', `${BACKEND}/api/auth/status`],
  ] as const) {
    try {
      const res = await ctx.get(url, { timeout: 5_000 });
      if (res.status() >= 500) throw new Error(`HTTP ${res.status()}`);
    } catch (err) {
      throw new Error(
        `e2e needs the panel up: ${what} at ${url} is not answering (${String(err)}).\n` +
          `Start the lab's dev servers (README.lab: panel-backend on :3000, panel-frontend on :5173) ` +
          `or point E2E_BASE_URL / E2E_API_URL somewhere else.`,
      );
    }
  }
  await ctx.dispose();
}
