import { test as base, expect, type Page, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'node:fs';

export const BACKEND = process.env.E2E_API_URL ?? 'http://127.0.0.1:3000';
export const ADMIN = {
  username: process.env.E2E_ADMIN_USER ?? 'lab',
  password: process.env.E2E_ADMIN_PASS ?? 'LabPassw0rd!2026',
};

/**
 * Everything this suite creates carries this prefix, and every spec deletes its
 * own by it. The lab database is shared with a running panel and with the
 * backend's own fixtures; a test that leaves `test-profile` behind is a test
 * that fails the next time it runs.
 */
export const E2E_PREFIX = 'e2e-';

/** Where auth.setup.ts leaves the signed-in storage state. Under .playwright/,
 *  which is on disk and gitignored. */
export const AUTH_STATE = './.playwright/auth.json';

/** Log in through the login FORM, not by injecting a token. Whether the panel
 *  keeps the session across a client-side navigation is part of what layer 3
 *  is for. */
export async function login(page: Page): Promise<number> {
  await page.goto('/login');
  // Long, and with its own message: against a dev server the first navigation
  // after a source edit can sit through a Vite re-optimise, and the failure
  // then reads as "the login page has no username field" rather than "the
  // bundle was still being built".
  const username = page.getByLabel('Username', { exact: true });
  await expect(username, 'the login form never rendered - dev server still building?').toBeVisible({
    timeout: 60_000,
  });
  await username.fill(ADMIN.username);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  // The form's own submit, not a name match: the button reads "Continue" here
  // and the page has other elements whose text is "Sign in".
  const answered = page.waitForResponse((r) => r.url().includes('/api/auth/login'));
  await page.locator('form button[type="submit"]').click();
  const status = (await answered).status();
  // `/api/auth/login` allows five attempts a minute per IP - that is the
  // panel's brute-force guard working, not a broken login. Reported as its own
  // outcome so a suite re-run inside the window says so instead of failing on
  // "still at /login", which is what it looked like for three runs.
  if (status === 429) return status;
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
  return status;
}

/**
 * An admin token for setup and teardown only - never to stand in for something
 * a test is supposed to do through the UI.
 *
 * Taken out of the storage state auth.setup.ts already saved rather than by
 * logging in again: `/api/auth/login` allows five attempts a minute per IP, and
 * a fresh login per spec file spends that budget on the suite itself. Two runs
 * back to back then fail on a 429 that looks like a broken login page - it did,
 * before this read the token instead of minting one.
 */
export async function adminApi(request: APIRequestContext): Promise<string> {
  try {
    const state = JSON.parse(readFileSync(AUTH_STATE, 'utf8')) as {
      origins: { localStorage: { name: string; value: string }[] }[];
    };
    for (const origin of state.origins ?? []) {
      const entry = (origin.localStorage ?? []).find((i) => i.name === 'iceslab-auth');
      const token = entry && (JSON.parse(entry.value) as { state?: { token?: string } }).state?.token;
      if (token) return token;
    }
  } catch {
    // No saved state (a spec run on its own, say): fall through and spend one.
  }
  const res = await request.post(`${BACKEND}/api/auth/login`, { data: ADMIN });
  expect(res.ok(), `admin login failed: ${res.status()}`).toBeTruthy();
  return (await res.json()).token as string;
}

export async function deleteLeftovers(request: APIRequestContext, token: string) {
  const headers = { authorization: `Bearer ${token}` };
  for (const [kind, key] of [
    ['profiles', 'profiles'],
    ['users', 'users'],
  ] as const) {
    const res = await request.get(`${BACKEND}/api/${kind}?limit=100`, { headers });
    if (!res.ok()) continue;
    const items = ((await res.json())[key] ?? []) as { id: string; name?: string; username?: string }[];
    for (const it of items) {
      const label = it.name ?? it.username ?? '';
      if (label.startsWith(E2E_PREFIX)) {
        await request.delete(`${BACKEND}/api/${kind}/${it.id}`, { headers });
      }
    }
  }
}

/**
 * Two things every page in this suite gets:
 *
 *  - Third-party requests blocked. The panel pulls its webfonts from
 *    fonts.googleapis.com, and Chromium cancels every in-flight request -
 *    including the ones to localhost - when the host's network changes under
 *    it. That showed up as a blank page and a locator timeout on a page that
 *    was fine a minute earlier. Nothing under test lives outside localhost, so
 *    the dependency is removed rather than waited on.
 *  - Uncaught page errors printed. A lazy route chunk that fails to load throws
 *    into no error boundary and the whole tree unmounts; without this the only
 *    evidence is a white screenshot.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.route(/^https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/, (route) => route.abort());
    page.on('pageerror', (err) => console.error('[page error]', err.message));

    // The panel rate-limits every route to 100 requests a minute per IP, in
    // Redis, so the window survives a restart. One run of this suite is well
    // under that; two back to back are not, and the 429 lands on whatever
    // request happens to be the hundred-and-first - an empty user table here, a
    // keypair button that does nothing there. Three different "failures" in
    // three runs, all of them this. Named explicitly so the suite never again
    // reports the symptom instead of the cause.
    const throttled: string[] = [];
    page.on('response', (res) => {
      if (res.status() === 429) throttled.push(new URL(res.url()).pathname);
    });

    await use(page);

    if (throttled.length > 0) {
      throw new Error(
        `the panel rate-limited this run (100 req/min per IP): ${[...new Set(throttled)].join(', ')}. ` +
          `Whatever this test asserted, it did not get the data to assert it on. Wait a minute and run again.`,
      );
    }
  },
});
export { expect };
