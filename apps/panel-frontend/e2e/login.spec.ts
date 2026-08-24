import { test, expect, login } from './fixtures';

/**
 * The one test that must NOT reuse the stored session: signing in is what it is
 * checking. Everything else in the suite starts already authenticated (see
 * auth.setup.ts and the rate limit it exists for).
 */
test.use({ storageState: { cookies: [], origins: [] } });

test('an admin signs in and the session survives a navigation', async ({ page }) => {
  const status = await login(page);
  test.skip(
    status === 429,
    'the panel rate-limits login to 5 attempts a minute per IP; give it a minute and run again',
  );
  expect(status, 'the panel refused the credentials').toBe(200);
  await expect(page, 'login must leave /login for a real page').not.toHaveURL(/\/login/);

  // A different code path from the redirect the login itself does: an unsent or
  // unpersisted token shows up here as a bounce back to /login.
  await page.goto('/profiles');
  await expect(page).toHaveURL(/\/profiles$/);
  // The list page's own action, not the editor's - it reads "Create" here.
  await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeVisible();
});
