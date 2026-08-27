/**
 * The AmneziaWG obfuscation rules the form must refuse, as data instead of as
 * closures inside a 2700-line component.
 *
 * These rules are written three times, in two languages, and the middle copy
 * says out loud why: `AmneziawgConfigSchema`'s superRefine in
 * `inbounds.schemas.ts` carries the comment "Mirror the constraints the node's
 * config.go validate() enforces at deploy time, so the operator gets a clear
 * form error instead of a confusing `config push failed` after save."
 *
 * The chain was one link short of that sentence. The node refuses; the panel
 * refuses; the FORM did not, so every one of these arrived as a 400 after the
 * operator pressed save, with the message on a field the form does not point
 * at. This is the missing link.
 *
 * What each rule is actually about, because none of them is arbitrary:
 *
 *   - H1-H4 pairwise distinct. A repeated header value collapses two packet
 *     types onto one marker; the node calls it "must be pairwise distinct" and
 *     refuses the interface outright.
 *   - Jmin <= Jmax. The junk-packet size range, inverted. The node names both
 *     numbers when it refuses.
 *   - s1 + 56 != s2. This one is the reason the block exists at all: that sum
 *     recreates the vanilla WireGuard handshake packet length, so the flow
 *     becomes DPI-detectable — a profile that looks configured, connects fine,
 *     and is exactly as visible as the plain protocol it was meant to disguise.
 *     The node does NOT check this one; the panel is the only side that does.
 *   - The two server keys. 44 base64 characters decoding to 32 bytes, which is
 *     what `wg genkey` emits and what the node's validateWGKey demands. Its
 *     comment records what the alphabet is really for: a `\n` in a pushed
 *     public key used to close `[Peer]` and open `[Interface]` with a PostUp of
 *     the sender's choosing.
 *
 * Rules return an i18n KEY, not a rendered string, for the same reason
 * `pq-pairs` does: a pure module cannot hold a `t`, and a test that asserts on
 * a key survives a copy edit to the message.
 */

/** The subset of the profile form an AmneziaWG rule reads. */
export interface AwgFormValues {
  protocol: string;
  awgJmin: number | '';
  awgJmax: number | '';
  awgS1: number | '';
  awgS2: number | '';
  awgH1: number | '';
  awgH2: number | '';
  awgH3: number | '';
  awgH4: number | '';
  awgServerPriv: string;
  awgServerPub: string;
}

export type AwgField =
  | 'awgJmax'
  | 'awgS2'
  | 'awgH1'
  | 'awgH2'
  | 'awgH3'
  | 'awgH4'
  | 'awgServerPriv'
  | 'awgServerPub';

/**
 * Every field an AmneziaWG rule can put a message on. Exported so the form
 * cannot wire six of the eight and look complete — the same reason PQ_FIELDS
 * is exported next door.
 */
export const AWG_FIELDS: readonly AwgField[] = [
  'awgJmax',
  'awgS2',
  'awgH1',
  'awgH2',
  'awgH3',
  'awgH4',
  'awgServerPriv',
  'awgServerPub',
];

/**
 * A WireGuard key as the node defines one: exactly 32 bytes, base64. 32 bytes
 * is 43 base64 characters plus one `=`, and the alphabet is the point — it
 * cannot express a newline or a shell metacharacter.
 */
export const WG_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

const H_FIELDS = ['awgH1', 'awgH2', 'awgH3', 'awgH4'] as const;

/**
 * The rule for one field, or null.
 *
 * Everything is skipped unless the profile IS AmneziaWG: the same form holds
 * every protocol's fields at once, and a WireGuard profile carries no
 * obfuscation block at all (`WireguardConfigSchema` has no `obfuscation`
 * member, deliberately).
 */
export function awgFieldError(field: AwgField, values: AwgFormValues): string | null {
  if (values.protocol !== 'amneziawg') return null;

  switch (field) {
    case 'awgJmax': {
      const min = values.awgJmin;
      const max = values.awgJmax;
      if (min === '' || max === '') return null;
      return min > max ? 'profiles.form.cfg.awgJminOverJmax' : null;
    }
    case 'awgS2': {
      const s1 = values.awgS1;
      const s2 = values.awgS2;
      if (s1 === '' || s2 === '') return null;
      return s1 + 56 === s2 ? 'profiles.form.cfg.awgS1PlusHandshake' : null;
    }
    case 'awgH1':
    case 'awgH2':
    case 'awgH3':
    case 'awgH4': {
      const own = values[field];
      if (own === '') return null;
      // Report on the LATER of a colliding pair, the way the backend does
      // (`path: [..., headers[j][0]]`), so two equal values light one field
      // rather than both and the operator has one thing to change.
      const idx = H_FIELDS.indexOf(field);
      for (let i = 0; i < idx; i += 1) {
        if (values[H_FIELDS[i]!] === own) return 'profiles.form.cfg.awgHDuplicate';
      }
      return null;
    }
    case 'awgServerPriv':
    case 'awgServerPub': {
      const v = values[field];
      // Empty is the `required` prop's business, not this rule's: saying
      // "not a valid key" about an untouched field is noise.
      if (v === '') return null;
      return WG_KEY_RE.test(v) ? null : 'profiles.form.cfg.awgKeyShape';
    }
    default:
      return null;
  }
}
