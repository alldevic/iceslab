import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../test/render';
import { PROTOCOL_CONFIG_SCHEMAS } from '../../../panel-backend/src/modules/inbounds/inbounds.schemas';

/**
 * Every profile kind the form offers must be creatable from the form's own
 * defaults, and the config it builds must be one the API accepts.
 *
 * This is §49's defect asked of the whole list instead of one entry. There, the
 * AmneziaWG branch started with H1-H4 empty, the submit read them as
 * `numOr(x, 0)`, and the request the operator's click produced came back with
 * TEN schema issues - a protocol nobody could create without opening a
 * collapsed section and typing four numbers nothing told them to type. The
 * form was one of fourteen kinds; the other thirteen had never been asked.
 *
 * The API half is the real `PROTOCOL_CONFIG_SCHEMAS`, imported rather than
 * restated. A fixture repeating those rules would be a second copy of the
 * contract and would go stale in exactly the direction that hides the bug.
 *
 * The per-kind fills below are ONLY the values an operator must supply because
 * no default could be right: a hostname, an ACME contact, a keypair. Everything
 * else is left as the form ships it - that is the whole point.
 */

/**
 * Two alphabets, and the mock has to know which is which: WireGuard's keys are
 * standard base64 (44 chars, `+` `/` `=`), xray's REALITY keys are base64url
 * (43 chars, `-` `_`, no padding) and the API rejects each in the other's
 * field. A mock handing the same object to both callers would pass the AmneziaWG
 * case and fail the REALITY one for a reason that is the mock's, not the form's.
 */
const WG_PRIV = 'H1skb6gXGFnftS9xrAzHUeNT/gIbGy34a9xq89xQHFM=';
const WG_PUB = 'aP8lgNU9c2vTGSvljeH1JO1qfCWQ6LwdVT92/RBO/FA=';
const RE_PRIV = 'H1skb6gXGFnftS9xrAzHUeNT_gIbGy34a9xq89xQHFM';
const RE_PUB = 'aP8lgNU9c2vTGSvljeH1JO1qfCWQ6LwdVT92_RBO_FA';
const PUB_FOR = { xray: RE_PUB, amneziawg: WG_PUB, wireguard: WG_PUB } as const;

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    listNodes: vi.fn(async () => ({ nodes: [], total: 0, page: 1, limit: 100 })),
    getRecipeRegistry: vi.fn(async () => ({ recipes: [], stale: false })),
    generateInboundKeypair: vi.fn(async (protocol: 'xray' | 'amneziawg' | 'wireguard' = 'amneziawg') =>
      protocol === 'xray'
        ? { privateKey: RE_PRIV, publicKey: RE_PUB }
        : { privateKey: WG_PRIV, publicKey: WG_PUB },
    ),
    generatePqKeys: vi.fn(async () => ({ seed: 'seed', client: 'client' })),
  };
});

import { ProfileFormModal } from './ProfileFormModal';

type User = ReturnType<typeof renderWithProviders>['user'];

async function type(user: User, label: string | RegExp, value: string): Promise<void> {
  const el = screen.getByLabelText(label);
  await user.clear(el);
  await user.click(el);
  await user.paste(value);
}

/** Click the keypair generator and wait for the public half to land. */
function generateKeypair(protocol: keyof typeof PUB_FOR) {
  return async (user: User): Promise<void> => {
    await user.click(screen.getByRole('button', { name: /^Generate$/ }));
    await waitFor(() =>
      expect((screen.getByLabelText(/public key/i) as HTMLInputElement).value).toBe(
        PUB_FOR[protocol],
      ),
    );
  };
}

interface Kind {
  /** The option label, which is also this case's name. */
  label: string;
  /** Which `PROTOCOL_CONFIG_SCHEMAS` entry validates what the form builds. */
  protocol: keyof typeof PROTOCOL_CONFIG_SCHEMAS;
  /** `null` when the protocol has one core; the pinned engine otherwise. */
  engine: 'singbox' | 'mtprotoproxy' | null;
  /** The values no default could supply. Absent = the defaults are complete. */
  fill?: (user: User) => Promise<void>;
}

const KINDS: Kind[] = [
  {
    label: 'Xray (native)',
    protocol: 'xray',
    engine: null,
    // REALITY needs a keypair and short IDs; both are per-deployment secrets.
    fill: async (user) => {
      await type(user, /Short IDs/i, '6ba85179e30d4fc2');
      await generateKeypair('xray')(user);
    },
  },
  { label: 'Hysteria 2 (native)', protocol: 'hysteria', engine: null },
  { label: 'Shadowsocks 2022 (native)', protocol: 'shadowsocks', engine: null },
  { label: 'AmneziaWG', protocol: 'amneziawg', engine: null, fill: generateKeypair('amneziawg') },
  { label: 'WireGuard', protocol: 'wireguard', engine: null, fill: generateKeypair('wireguard') },
  {
    label: 'NaiveProxy',
    protocol: 'naive',
    engine: null,
    // Caddy fetches a Let's Encrypt certificate on start, so both the name it
    // is issued for and the ACME contact are the operator's to give.
    fill: async (user) => {
      await type(user, /Public hostname/i, 'naive.example.com');
      await type(user, /TLS contact email/i, 'ops@example.com');
    },
  },
  { label: 'MTProto (Telegram-only, mtg — one shared secret)', protocol: 'mtproto', engine: null },
  // The same protocol on its other core. Worth its own row rather than trusting
  // the mtg one: the two differ in what the form must SEND, and a form that
  // silently sent null here would move every buyer back to the shared secret.
  {
    label: 'MTProto (Telegram-only, multi-user — secret per user)',
    protocol: 'mtproto',
    engine: 'mtprotoproxy',
  },
  { label: 'Mieru (stealth proxy)', protocol: 'mieru', engine: null },
  {
    label: 'Xray (VLESS/VMess/Trojan)',
    protocol: 'xray',
    engine: 'singbox',
    fill: async (user) => {
      await type(user, /Short IDs/i, '6ba85179e30d4fc2');
      await generateKeypair('xray')(user);
    },
  },
  { label: 'Hysteria 2', protocol: 'hysteria', engine: 'singbox' },
  { label: 'Shadowsocks 2022', protocol: 'shadowsocks', engine: 'singbox' },
  // TUIC / AnyTLS / ShadowTLS exist on sing-box only, so the form pins no
  // engine and the node's NativeEngine() resolves them to it.
  { label: 'TUIC', protocol: 'tuic', engine: null },
  { label: 'AnyTLS', protocol: 'anytls', engine: null },
  { label: 'ShadowTLS', protocol: 'shadowtls', engine: null },
];

describe('every profile kind can be created from the form defaults', () => {
  /**
   * The enumeration this file runs on, controlled a second way. The list above
   * is hand-written, so on its own it proves nothing about a kind nobody
   * remembered to add: a fifteenth option in the select, or a twelfth protocol
   * in the API, would simply not be tested and nothing would say so.
   */
  it('covers every protocol the API has a schema for, and offers no other', async () => {
    renderWithProviders(
      <ProfileFormModal opened onClose={() => {}} profile={null} onSubmit={vi.fn()} loading={false} />,
    );
    const covered = new Set(KINDS.map((k) => k.protocol));
    expect([...covered].sort()).toEqual(Object.keys(PROTOCOL_CONFIG_SCHEMAS).sort());
  });

  for (const kind of KINDS) {
    it(`${kind.label}`, async () => {
      const onSubmit = vi.fn(async () => {});
      const { user } = renderWithProviders(
        <ProfileFormModal opened onClose={() => {}} profile={null} onSubmit={onSubmit} loading={false} />,
      );

      // Two things answer to "Protocol": the select input and the section card
      // whose title is the same word. Take the input.
      const protocolInput = screen
        .getAllByLabelText('Protocol')
        .find((el) => el.tagName === 'INPUT');
      expect(protocolInput, 'no Protocol input in the form').toBeDefined();
      await user.click(protocolInput!);
      await user.click((await screen.findAllByRole('option', { name: kind.label }))[0]);

      await type(user, /^Name/i, 'defaults-probe');
      await kind.fill?.(user);

      // A required field left empty makes the browser refuse to submit at all,
      // and every assertion below would then pass for a reason that has nothing
      // to do with the defaults. Name what is empty rather than time out.
      const form = document.getElementById('profile-form') as HTMLFormElement;
      const blocked = Array.from(form.querySelectorAll('input,textarea,select'))
        .filter((el) => !(el as HTMLInputElement).checkValidity())
        .map((el) => {
          const labels = (el as HTMLInputElement).labels;
          return labels?.length ? (labels[0].textContent ?? '') : `#${el.id}`;
        });
      expect(blocked, 'the form will not submit its own defaults').toEqual([]);

      await user.click(screen.getByRole('button', { name: 'Create profile' }));
      // A refusal by the form's own validators looks like "nothing happened",
      // so read the messages back off the screen rather than time out on a
      // call count. This is the half the operator sees.
      await waitFor(() => {
        if (onSubmit.mock.calls.length === 1) return;
        const said = Array.from(document.querySelectorAll('.mantine-InputWrapper-error'))
          .map((el) => el.textContent)
          .filter(Boolean);
        throw new Error(
          `the form refused to save its own defaults${said.length ? `: ${said.join(' | ')}` : ' and said nothing about why'}`,
        );
      });

      const payload = (onSubmit.mock.calls as unknown[][])[0][0] as {
        protocol: string;
        engine: string | null;
        config: unknown;
      };
      expect(payload.protocol).toBe(kind.protocol);
      expect(payload.engine).toBe(kind.engine);

      const parsed = PROTOCOL_CONFIG_SCHEMAS[kind.protocol].safeParse(payload.config);
      expect(
        parsed.success
          ? []
          : parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
        'the API refuses the config this form built from its own defaults',
      ).toEqual([]);
    });
  }
});
