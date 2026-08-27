import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../test/render';

/**
 * Layer 2 for the AmneziaWG obfuscation rules: `lib/awgRules.test.ts` proves
 * the rules, `lib/awgRules.mirror.test.ts` proves the node and the panel schema
 * carry the same ones, and this file proves the FORM runs them — that a refused
 * save is refused, and that the operator can see why and where.
 *
 * That is the half the other two cannot reach. A rule module wired to six of
 * its eight fields, or wired with the message landing on a control inside a
 * collapsed section, passes both of them and still leaves the operator pressing
 * save and watching nothing happen.
 *
 * The generated keypair here is a REAL one in shape, because the form now
 * validates key shape: a mock returning `{privateKey:'x'}` would make the save
 * fail for a reason that has nothing to do with obfuscation.
 */

const PRIV = 'H1skb6gXGFnftS9xrAzHUeNT/gIbGy34a9xq89xQHFM=';
const PUB = 'aP8lgNU9c2vTGSvljeH1JO1qfCWQ6LwdVT92/RBO/FA=';

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    listNodes: vi.fn(async () => ({ nodes: [], total: 0, page: 1, limit: 100 })),
    getRecipeRegistry: vi.fn(async () => ({ recipes: [], stale: false })),
    generateInboundKeypair: vi.fn(async () => ({ privateKey: PRIV, publicKey: PUB })),
    generatePqKeys: vi.fn(),
  };
});

import { ProfileFormModal } from './ProfileFormModal';

const MESSAGE = {
  hDuplicate:
    'H1-H4 must all differ; a repeated value collapses two packet types onto one marker.',
  jminOverJmax: 'Jmin must not exceed Jmax; the node refuses the inverted range.',
  s1Handshake:
    'S1 + 56 equals S2, which recreates the plain WireGuard handshake length and makes the flow detectable.',
  keyShape: 'Not a WireGuard key: expected 44 base64 characters, as `wg genkey` emits.',
};

async function fill(
  user: ReturnType<typeof renderWithProviders>['user'],
  label: string | RegExp,
  value: string,
) {
  const el = screen.getByLabelText(label);
  await user.clear(el);
  await user.click(el);
  await user.paste(value);
}

/** An AmneziaWG profile with every `required` satisfied and nothing wrong. */
async function openAwgForm() {
  const onSubmit = vi.fn(async () => {});
  const view = renderWithProviders(
    <ProfileFormModal opened onClose={() => {}} profile={null} onSubmit={onSubmit} loading={false} />,
  );
  const { user } = view;

  // Two things answer to "Protocol": the select, and the section card whose
  // title is the same word. Take the input.
  const protocolInput = screen
    .getAllByLabelText('Protocol')
    .find((el) => el.tagName === 'INPUT');
  expect(protocolInput, 'no Protocol input in the form').toBeDefined();
  await user.click(protocolInput!);
  await user.click(await screen.findByRole('option', { name: 'AmneziaWG' }));
  await screen.findByLabelText(/Subnet/i);

  await fill(user, /^Name/i, 'awg-profile');
  await fill(user, /Subnet/i, '10.66.66.0/24');
  await user.click(screen.getByRole('button', { name: /^Generate$/ }));
  await waitFor(() =>
    expect((screen.getByLabelText(/Server public key/i) as HTMLInputElement).value).toBe(PUB),
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
  // The same guard the PQ file carries: one empty `required` anywhere and the
  // browser refuses to submit at all, so every assertion below would pass for
  // a reason that has nothing to do with obfuscation.
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

describe('the form runs the AmneziaWG obfuscation rules at all', () => {
  it('builds a default profile the API would accept', async () => {
    // The control for every refusal below, and a case in its own right.
    //
    // Measured 2026-08-27, before AWG_HEADER_DEFAULTS existed: the four magic
    // header fields started EMPTY and the submit read them as `numOr(x, 0)`, so
    // this exact click path built `h1..h4 = 0`. Fed to the real
    // AmneziawgConfigSchema that came back with ten issues — four "expected
    // >= 5" and six "must be pairwise distinct", because all four zeros are
    // equal — and the node refuses the same thing at deploy. An operator could
    // not create an AmneziaWG profile without opening the obfuscation block and
    // typing four numbers nothing told them to type.
    const { user, onSubmit } = await openAwgForm();
    const cfg = await save(user, onSubmit);
    expect(cfg, 'the form refused its own defaults').not.toBeNull();

    const obf = cfg!.obfuscation as Record<string, number>;
    expect(obf.jmin).toBe(64);
    for (const h of ['h1', 'h2', 'h3', 'h4'] as const) {
      expect(obf[h], `${h} is below the schema's floor of 5`).toBeGreaterThanOrEqual(5);
    }
    expect(new Set([obf.h1, obf.h2, obf.h3, obf.h4]).size, 'the four headers are not distinct').toBe(4);
  });

  it('refuses a repeated magic header and says so on the field', async () => {
    const { user, onSubmit } = await openAwgForm();
    const h1 = (screen.getByLabelText('H1') as HTMLInputElement).value;
    expect(h1, 'H1 starts empty, so this case would set H2 to nothing').not.toBe('');
    await fill(user, 'H2', h1);

    expect(await save(user, onSubmit)).toBeNull();
    expect(screen.getByText(MESSAGE.hDuplicate)).toBeVisible();
  });

  it('refuses an inverted junk range', async () => {
    const { user, onSubmit } = await openAwgForm();
    await fill(user, 'Jmin', '512');

    expect(await save(user, onSubmit)).toBeNull();
    expect(screen.getByText(MESSAGE.jminOverJmax)).toBeVisible();
  });

  it('refuses the one S1 that recreates the plain WireGuard handshake', async () => {
    // S2 is 56 in both presets, so this is a single keystroke away: S1 = 0.
    const { user, onSubmit } = await openAwgForm();
    await fill(user, 'S1', '0');

    expect(await save(user, onSubmit)).toBeNull();
    expect(screen.getByText(MESSAGE.s1Handshake)).toBeVisible();
  });

  it('refuses a pasted key that is not one', async () => {
    const { user, onSubmit } = await openAwgForm();
    await fill(user, /Server public key/i, 'not-a-wireguard-key');

    expect(await save(user, onSubmit)).toBeNull();
    expect(screen.getByText(MESSAGE.keyShape)).toBeVisible();
  });
});
