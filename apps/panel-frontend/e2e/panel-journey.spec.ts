import { test, expect, BACKEND, E2E_PREFIX, adminApi, deleteLeftovers } from './fixtures';

/**
 * What an operator does after signing in (login itself is login.spec.ts):
 * build a profile, get refused for half a post-quantum pair, and hand a user
 * their subscription.
 *
 * Deliberately end-to-end at both ends: the browser drives the real panel, and
 * the assertions read the real database through the API rather than trusting
 * what the form said it sent.
 */

const SEED =
  'wgEfPGrDbLGwt2xWKtq0uwOSlbEwm6b5EYTBQkzFuqYCwB8Ib2zHZpVIcnDbEeR8kBhTYT0DBGpTRRHIS3g6zw';
/**
 * An ML-DSA-65 public key is exactly 1952 bytes and the backend rejects any
 * other length, so the fixture is built to that length rather than typed out.
 * The bytes are not a real key - xray would refuse them at push time - and this
 * test never pushes: what it exercises is the panel's save path and the schema
 * behind it, both of which care only about the length.
 */
const VERIFY = Buffer.alloc(1952, 0x41).toString('base64');

let token = '';
let profileName = '';
let userName = '';

test.beforeAll(async ({ request }) => {
  token = await adminApi(request);
  await deleteLeftovers(request, token);
});

test.afterAll(async ({ request }) => {
  await deleteLeftovers(request, token);
});

test.beforeEach(() => {
  // Unique per test so a run that dies half way does not collide with the next
  // one before teardown gets a chance.
  const stamp = Date.now().toString(36);
  profileName = `${E2E_PREFIX}profile-${stamp}`;
  userName = `${E2E_PREFIX}user-${stamp}`;
});

test('a REALITY profile with half a post-quantum pair is refused, and the reason is on screen', async ({
  page,
  request,
}) => {
  await page.goto('/profiles/new');

  // Mantine puts the required marker inside the label, so the accessible name
  // is "Name *" and an exact match finds nothing.
  await page.getByLabel(/^Name/).fill(profileName);
  await page.getByLabel(/Short IDs/i).fill('6ba85179e30d4fc2');
  await page.getByRole('button', { name: /^Generate$/ }).click();
  await expect(page.getByLabel(/REALITY public key/i)).not.toHaveValue('');

  // Half a pair: the server seed with no verify key. xray would take the
  // classical branch and mark the connection verified, so the panel refuses it.
  await page.getByRole('button', { name: /^Advanced: REALITY/ }).click();
  await page.getByRole('tab', { name: 'Post-quantum' }).click();
  await page.getByLabel('REALITY ML-DSA-65 seed (server)').fill(SEED);

  // Walk away from the tab before saving. This is the state that used to refuse
  // the save with the explanation sitting under an inline `display: none`.
  await page.getByRole('tab', { name: 'REALITY' }).click();
  // Inline mode has no submit button of its own; the page bar's one drives the
  // form by id.
  await page.getByRole('button', { name: 'Create profile' }).click();

  const refusal = page.getByText(/Also needs the verify key/i);
  await expect(refusal, 'the refusal must be visible, not merely mounted').toBeVisible();
  await expect(page, 'a refused save must not navigate away').toHaveURL(/\/profiles\/new$/);

  // Nothing was written. Checked in the database, not in the UI: a form can
  // show a message and still have posted.
  const listed = await request.get(`${BACKEND}/api/profiles?limit=100`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const names = ((await listed.json()).profiles as { name: string }[]).map((p) => p.name);
  expect(names).not.toContain(profileName);
});

test('completing the pair saves the profile with both halves', async ({ page, request }) => {
  await page.goto('/profiles/new');

  // Mantine puts the required marker inside the label, so the accessible name
  // is "Name *" and an exact match finds nothing.
  await page.getByLabel(/^Name/).fill(profileName);
  await page.getByLabel(/Short IDs/i).fill('6ba85179e30d4fc2');
  await page.getByRole('button', { name: /^Generate$/ }).click();
  await expect(page.getByLabel(/REALITY public key/i)).not.toHaveValue('');

  await page.getByRole('button', { name: /^Advanced: REALITY/ }).click();
  await page.getByRole('tab', { name: 'Post-quantum' }).click();

  // Both halves, pasted. The keygen button is the operator's real route, but it
  // asks a node over mTLS: with the lab's guests down it has nothing to ask,
  // and a test that skipped itself in that case would prove nothing on most
  // runs. The save path and the schema behind it are the same either way.
  await page.getByLabel('REALITY ML-DSA-65 seed (server)').fill(SEED);
  await page.getByLabel('REALITY ML-DSA-65 verify key (client)').fill(VERIFY);

  await page.getByRole('button', { name: 'Create profile' }).click();
  await expect(page).toHaveURL(/\/profiles$/, { timeout: 20_000 });

  const listed = await request.get(`${BACKEND}/api/profiles?limit=100`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const saved = ((await listed.json()).profiles as { name: string; config: Record<string, string> }[])
    .find((p) => p.name === profileName);
  expect(saved, 'the profile the form said it created').toBeDefined();
  expect(saved!.config.realityMldsa65Seed).toBe(SEED);
  expect(saved!.config.realityMldsa65Verify, 'both halves or neither').toBe(VERIFY);
});

test('a new user gets a subscription that actually serves a config', async ({ page, request }) => {
  await page.goto('/users');

  await page.getByRole('button', { name: /create user/i }).click();
  await page.getByPlaceholder('kate_m').fill(userName);
  await page.getByRole('button', { name: 'Create', exact: true }).click();

  // The drawer closing IS the panel saying the create went through. Asserting
  // on the table first hid that: a create the form refused left the drawer open
  // and the test blamed the missing row.
  await expect(
    page.getByPlaceholder('kate_m'),
    'the create drawer stayed open, so the panel refused the user',
  ).toBeHidden({ timeout: 15_000 });

  // Find it by searching rather than by scanning the table: the list is paged
  // and ordered by the panel's own rules, so "the row is somewhere on screen"
  // is true only while the lab has few enough accounts - a test that passes for
  // that reason stops passing the week the lab fills up.
  await page.getByPlaceholder(/Search by username/i).fill(userName);
  await expect(page.getByText(userName).first()).toBeVisible({ timeout: 15_000 });

  // The token the panel just minted, read back through the API because the URL
  // the UI prints points at the lab's TLS front on 10.0.2.2 - an address that
  // exists for the guests, not for the host this test runs on (README.lab).
  const listed = await request.get(`${BACKEND}/api/users?limit=100`, {
    headers: { authorization: `Bearer ${token}` },
  });
  // Say what the panel answered before reading a field off it. Without this the
  // failure is `Cannot read properties of undefined (reading 'find')`, which
  // names neither the request nor the reason — and the reason here is usually
  // 429: the browser's own traffic and this request share an IP and the same
  // 100-per-minute bucket.
  expect(
    listed.status(),
    `GET /api/users answered ${listed.status()}: ${(await listed.text()).slice(0, 200)}`,
  ).toBe(200);
  const created = ((await listed.json()).users as { username: string; subscriptionToken: string }[])
    .find((u) => u.username === userName);
  expect(created, 'the user the drawer said it created').toBeDefined();

  const sub = await request.get(`${BACKEND}/sub/${created!.subscriptionToken}`, {
    headers: { 'user-agent': 'v2rayNG/1.8.0' },
  });
  expect(sub.status(), 'the subscription the user is handed').toBe(200);
  const body = await sub.text();
  // Base64 or plain, it must not be empty: an empty 200 is what a subscription
  // looks like when the squad, the profile and the node binding never met.
  expect(body.trim().length, 'an empty 200 is a subscription that serves nothing').toBeGreaterThan(0);
});
