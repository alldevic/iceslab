import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../test/render';

/**
 * The form half of the REALITY transport rule.
 *
 * xray 26.3.27 refuses to load a REALITY inbound on ws / httpupgrade / kcp
 * outright - `infra/conf: REALITY only supports RAW, XHTTP and gRPC for now.` -
 * and the node's core then restart-loops, taking every other inbound on that
 * node with it. The schema started refusing the pair at save; this file is
 * about the operator never being invited to build it in the first place.
 *
 * There is a specific reason to test it here rather than trust the string.
 * `profiles.form.cfg.realityNetworkDesc` has stated this rule in both locales
 * since v0.1.0 and no .tsx ever referenced it: the constraint was written down,
 * shipped, translated, and shown to nobody. A key that exists is not a key that
 * renders, so every case below reads the screen or the submitted config.
 */

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    listNodes: vi.fn(async () => ({ nodes: [], total: 0, page: 1, limit: 100 })),
    getRecipeRegistry: vi.fn(async () => ({ recipes: [], stale: false })),
    generateInboundKeypair: vi.fn(async () => ({ privateKey: 'x', publicKey: 'y' })),
    generatePqKeys: vi.fn(),
  };
});

import { ProfileFormModal } from './ProfileFormModal';

const RULE = 'REALITY supports raw / xhttp / grpc';

const pill = (name: string) => screen.getByRole('button', { name });

async function fill(
  user: ReturnType<typeof renderWithProviders>['user'],
  label: string | RegExp,
  value: string,
) {
  const el = screen.getByLabelText(label);
  await user.click(el);
  await user.paste(value);
}

/**
 * A form ready to submit. The REALITY defaults carry three `required` inputs
 * that start empty; leave any of them and the browser refuses to submit at all,
 * so `onSubmit` never runs and a test about the transport would be watching the
 * save fail for an unrelated reason.
 */
async function openForm() {
  const onSubmit = vi.fn(async () => {});
  const view = renderWithProviders(
    <ProfileFormModal opened onClose={() => {}} profile={null} onSubmit={onSubmit} loading={false} />,
  );
  const { user } = view;
  await fill(user, /^Name/i, 'transport-profile');
  await fill(user, /Short IDs/i, '6ba85179e30d4fc2');
  await user.click(screen.getByRole('button', { name: /^Generate$/ }));
  await waitFor(() =>
    expect((screen.getByLabelText(/REALITY public key/i) as HTMLInputElement).value).not.toBe(''),
  );
  return { ...view, user, onSubmit };
}

async function save(
  user: ReturnType<typeof renderWithProviders>['user'],
  onSubmit: ReturnType<typeof vi.fn>,
): Promise<Record<string, unknown> | null> {
  const form = document.getElementById('profile-form') as HTMLFormElement;
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

describe('the form will not build a REALITY inbound xray refuses to load', () => {
  it('offers only the three transports REALITY carries, and says why', async () => {
    await openForm(); // a new xray profile defaults to security=reality

    for (const ok of ['raw', 'xhttp', 'gRPC']) expect(pill(ok)).toBeEnabled();
    for (const no of ['ws', 'httpupgrade', 'mKCP']) expect(pill(no)).toBeDisabled();

    // Visible, not merely in the DOM. The whole defect this replaces was a
    // string that existed and never reached a screen.
    expect(screen.getByText(RULE)).toBeVisible();
  });

  it('gives all six back when the security that constrains them is off', async () => {
    const { user } = await openForm();
    await user.click(pill('none'));

    // The control. Without it the case above would also pass against a form
    // that had simply lost ws, httpupgrade and kcp altogether - and those three
    // are exactly the CDN-frontable ones, the reason an operator picks
    // security=none to begin with.
    for (const each of ['raw', 'xhttp', 'gRPC', 'ws', 'httpupgrade', 'mKCP']) {
      expect(pill(each)).toBeEnabled();
    }
    expect(screen.queryByText(RULE)).toBeNull();
  });

  it('snaps the transport back when REALITY is switched on over ws', async () => {
    // The other order of clicks, and the one disabling a pill cannot catch: the
    // transport is chosen first and REALITY arrives after it. Read off the
    // config the form SUBMITS, not off the pills - what reaches the node is the
    // only version of this that matters.
    const { user, onSubmit } = await openForm();
    await user.click(pill('none'));
    await user.click(pill('ws'));
    await user.click(pill('REALITY'));

    const config = await save(user, onSubmit);
    expect(config).not.toBeNull();
    expect(config!.security).toBe('reality');
    expect(config!.network).toBe('raw');
  });

  it('leaves a legal REALITY transport alone', async () => {
    // Same three clicks, one legal value. A form that answered the REALITY
    // click by resetting the transport unconditionally would pass the case
    // above and quietly discard a deliberate xhttp choice here.
    const { user, onSubmit } = await openForm();
    await user.click(pill('none'));
    await user.click(pill('xhttp'));
    await user.click(pill('REALITY'));

    const config = await save(user, onSubmit);
    expect(config).not.toBeNull();
    expect(config!.network).toBe('xhttp');
  });
});
