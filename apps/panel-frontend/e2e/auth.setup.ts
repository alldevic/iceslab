import { test as setup, login, AUTH_STATE } from './fixtures';

/**
 * Sign in once per run and keep the storage state (the panel persists its JWT
 * in localStorage), because `/api/auth/login` is rate-limited to five attempts
 * a minute per IP - deliberately, it is the panel's brute-force guard. A suite
 * that logs in from every test spends that budget on itself and then fails with
 * a 429 that looks like a broken login page.
 */
setup('authenticate', async ({ page }) => {
  const status = await login(page);
  if (status !== 200) {
    throw new Error(
      `could not sign in to save the shared session (HTTP ${status}). ` +
        `429 means a previous run used up the five-a-minute login budget; wait a minute.`,
    );
  }
  await page.context().storageState({ path: AUTH_STATE });
});
