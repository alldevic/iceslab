import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../test/render';

/**
 * Layer 2 for the U5 pair gate: the rules themselves are proven in
 * lib/pq-pairs.test.ts, and this file proves the OTHER half - that the form
 * actually runs them, that a refused save is refused, and that the operator can
 * SEE why.
 *
 * That last one is the point. The PQ fields live inside a collapsed section and
 * a non-active tab, so a validator that fires with the section shut would block
 * every save with nothing on screen to explain it: the exact "gate green,
 * function dead" shape this fork keeps hitting from the other direction.
 */

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    // Every network call the form or its children make on mount. Left as
    // rejections they surface as console noise and an empty recipe rail, which
    // is indistinguishable from a broken render.
    listNodes: vi.fn(async () => ({ nodes: [], total: 0, page: 1, limit: 100 })),
    getRecipeRegistry: vi.fn(async () => ({ recipes: [], stale: false })),
    generateInboundKeypair: vi.fn(async () => ({ privateKey: 'x', publicKey: 'y' })),
    generatePqKeys: vi.fn(),
  };
});

import { ProfileFormModal } from './ProfileFormModal';

const SEED = 'FbUuTGwFDMOn2ptl9CyMBFQrOTeoHTAJpVnT9RHwXpk';
const VERIFY = 'a'.repeat(2604);
const DECRYPTION = 'mlkem768x25519plus.native.600s.' + 'b'.repeat(88);
const ENCRYPTION = 'mlkem768x25519plus.native.0rtt.' + 'c'.repeat(1580);

const LABEL = {
  seed: 'REALITY ML-DSA-65 seed (server)',
  verify: 'REALITY ML-DSA-65 verify key (client)',
  decryption: 'VLESS-Encryption (ML-KEM-768), server',
  encryption: 'VLESS-Encryption (ML-KEM-768), client',
};

const MESSAGE = {
  needsVerify: 'Also needs the verify key: without it clients never check the signature.',
  needsSeed: 'Also needs the server seed, or clients demand a signature the node never sends.',
  needsEncryption: 'Also needs the client string, or nobody can connect to this profile.',
  needsDecryption:
    'Also needs the server string, or clients encrypt to an inbound that decrypts nothing.',
};

/**
 * Put a value in a field the way an operator does with key material: paste it.
 * `user.type` replays a keydown/keypress/input triple per character, and a real
 * ML-DSA-65 verify key is 2604 of them - the test times out long before the
 * form is wrong about anything.
 */
async function fill(
  user: ReturnType<typeof renderWithProviders>['user'],
  label: string | RegExp,
  value: string,
) {
  const el = screen.getByLabelText(label);
  await user.click(el);
  await user.paste(value);
}

async function openForm() {
  const onSubmit = vi.fn(async () => {});
  const view = renderWithProviders(
    <ProfileFormModal opened onClose={() => {}} profile={null} onSubmit={onSubmit} loading={false} />,
  );
  const { user } = view;

  // A default xray profile is security=reality, and REALITY carries three
  // `required` inputs that start empty: short IDs and both halves of the
  // keypair. The browser refuses to submit a form with an unsatisfied
  // `required`, so React's onSubmit never runs and nothing about PQ is
  // exercised - a test that skipped this would "prove" the pair gate by
  // watching the browser block the save for an unrelated reason.
  await fill(user, /^Name/i, 'pq-profile');
  await fill(user, /Short IDs/i, '6ba85179e30d4fc2');
  await user.click(screen.getByRole('button', { name: /^Generate$/ }));
  await waitFor(() =>
    expect((screen.getByLabelText(/REALITY public key/i) as HTMLInputElement).value).not.toBe(''),
  );
  return { ...view, user, onSubmit };
}

/** Submit and let React settle. Returns the config the form built, or null when
 *  the save was refused. */
async function save(
  user: ReturnType<typeof renderWithProviders>['user'],
  onSubmit: ReturnType<typeof vi.fn>,
): Promise<Record<string, unknown> | null> {
  const form = document.getElementById('profile-form') as HTMLFormElement;
  // Guard against the silent variant of the above: an empty `required` field
  // anywhere makes the click a no-op, and every assertion below would pass for
  // the wrong reason.
  const blocked = Array.from(form.querySelectorAll('input,textarea,select')).filter(
    (el) => !(el as HTMLInputElement).checkValidity(),
  );
  expect(
    blocked.map((el) => el.getAttribute('aria-label') ?? el.id),
    'a required field is empty, so the browser will not submit this form at all',
  ).toEqual([]);

  await user.click(screen.getByRole('button', { name: 'Create profile' }));
  await waitFor(() => expect(document.querySelector('#profile-form')).not.toBeNull());
  if (onSubmit.mock.calls.length === 0) return null;
  return (onSubmit.mock.calls[0][0] as { config: Record<string, unknown> }).config;
}

/** Open the Advanced section and switch to the post-quantum tab - the two
 *  clicks an operator makes before the fields exist on screen. */
async function openPqTab(user: ReturnType<typeof renderWithProviders>['user']) {
  await user.click(screen.getByRole('button', { name: /^Advanced: REALITY/ }));
  // Mantine's Collapse opens over two nested requestAnimationFrame callbacks,
  // so the tabs exist in the DOM but are still `display: none` (and therefore
  // invisible to a role query) for a frame or two after the click. findByRole
  // is what waits for that; getByRole here would fail with "no tab named
  // Post-quantum", which reads like the section does not have one.
  await user.click(await screen.findByRole('tab', { name: 'Post-quantum' }));
  await screen.findByLabelText(LABEL.seed);
}

describe('the form runs the PQ pair rules at all', () => {
  it('refuses to save a REALITY seed with no verify key, and says so on the empty field', async () => {
    const { user, onSubmit } = await openForm();
    await openPqTab(user);

    await fill(user, LABEL.seed, SEED);
    expect(await save(user, onSubmit)).toBeNull();

    // Visible, not merely present: the field sits in a Collapse and a Tabs
    // panel, either of which can hide the only explanation the operator gets.
    expect(screen.getByText(MESSAGE.needsVerify)).toBeVisible();
  });

  it('saves once the verify key is there, with both halves on the wire', async () => {
    const { user, onSubmit } = await openForm();
    await openPqTab(user);

    await fill(user, LABEL.seed, SEED);
    await fill(user, LABEL.verify, VERIFY);

    const config = await save(user, onSubmit);
    expect(config?.realityMldsa65Seed).toBe(SEED);
    expect(config?.realityMldsa65Verify).toBe(VERIFY);
  });

  it('refuses the VLESS-Encryption server half alone, and blames the client field', async () => {
    const { user, onSubmit } = await openForm();
    await openPqTab(user);

    await fill(user, LABEL.decryption, DECRYPTION);
    expect(await save(user, onSubmit)).toBeNull();
    expect(screen.getByText(MESSAGE.needsEncryption)).toBeVisible();
  });

  it('refuses the client half alone, and blames the server field', async () => {
    const { user, onSubmit } = await openForm();
    await openPqTab(user);

    await fill(user, LABEL.encryption, ENCRYPTION);
    expect(await save(user, onSubmit)).toBeNull();
    expect(screen.getByText(MESSAGE.needsDecryption)).toBeVisible();
  });

  it('saves both VLESS-Encryption halves together', async () => {
    const { user, onSubmit } = await openForm();
    await openPqTab(user);

    await fill(user, LABEL.decryption, DECRYPTION);
    await fill(user, LABEL.encryption, ENCRYPTION);

    const config = await save(user, onSubmit);
    expect(config?.vlessDecryption).toBe(DECRYPTION);
    expect(config?.vlessEncryption).toBe(ENCRYPTION);
  });

  it('a profile with no PQ material saves and carries no PQ keys', async () => {
    const { user, onSubmit } = await openForm();
    const config = await save(user, onSubmit);
    expect(config).not.toBeNull();
    for (const k of [
      'realityMldsa65Seed',
      'realityMldsa65Verify',
      'vlessDecryption',
      'vlessEncryption',
    ]) {
      expect(config, k).not.toHaveProperty(k);
    }
  });
});

describe('the operator can find the refusal', () => {
  /**
   * The realistic way to hit a half-pair without looking at it: fill one half,
   * move to another tab, then save. Mantine keeps inactive panels mounted, so
   * the message is in the DOM either way - what matters is whether a human
   * sees it.
   */
  it('a message raised on a tab the operator has left is still reachable', async () => {
    const { user, onSubmit } = await openForm();
    await openPqTab(user);
    await fill(user, LABEL.seed, SEED);

    await user.click(screen.getByRole('tab', { name: 'REALITY' }));
    expect(await save(user, onSubmit)).toBeNull();

    const message = screen.queryByText(MESSAGE.needsVerify);
    expect(message, 'the form refused the save but printed no reason anywhere').not.toBeNull();
    expect(
      message,
      'the reason is mounted but hidden: the save silently does nothing',
    ).toBeVisible();
  });

  it('a message raised with the Advanced section shut is still reachable', async () => {
    const { user, onSubmit } = await openForm();
    await openPqTab(user);
    await fill(user, LABEL.verify, VERIFY);

    // Collapse the whole section again, the way an operator tidies up before
    // hitting save.
    await user.click(screen.getByRole('button', { name: /^Advanced: REALITY/ }));
    expect(await save(user, onSubmit)).toBeNull();

    const message = screen.queryByText(MESSAGE.needsSeed);
    expect(message, 'the form refused the save but printed no reason anywhere').not.toBeNull();
    expect(message, 'the reason is inside a shut Collapse: the save silently does nothing').toBeVisible();
  });
});

describe('the gates the rules ride on', () => {
  it('a lone seed under security=tls neither blocks the save nor reaches the wire', async () => {
    const { user, onSubmit } = await openForm();
    await openPqTab(user);
    await fill(user, LABEL.seed, SEED);

    // Security is a chip row on the main body, not a select in the Advanced
    // block: switching it away from REALITY is what turns the ML-DSA-65 gate
    // off.
    await user.click(screen.getByRole('button', { name: 'TLS' }));

    const config = await save(user, onSubmit);
    expect(config).not.toBeNull();
    expect(config).not.toHaveProperty('realityMldsa65Seed');
  });
});
