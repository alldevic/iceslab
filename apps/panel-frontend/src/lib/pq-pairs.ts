/**
 * U5 post-quantum pair rules for the profile form, as data instead of as four
 * closures inside a 2700-line component.
 *
 * Both PQ features are PAIRS - a server half the node renders and a client half
 * the subscription hands out - and saving one without the other is the failure
 * this fork keeps finding: the panel shows the feature as on and it does
 * nothing, or worse. The asymmetry is the reason both are refused:
 *
 *   - VLESS-Encryption without its client half: the inbound demands an ML-KEM
 *     handshake while every link the panel emits still says `encryption=none`.
 *     Loud - nobody can connect to the profile.
 *   - PQ REALITY without its verify key: xray checks the extra ML-DSA-65
 *     signature only when the client holds a verify key, and otherwise takes
 *     the classical branch and marks the connection verified. Silent - the
 *     profile advertises post-quantum and delivers X25519.
 *
 * The backend refuses the same four states in `inbounds.schemas.ts`'s
 * superRefine. This is the client half of that gate, and it exists so the
 * message lands on the field that is empty rather than arriving as a 400 with
 * no idea which box to fill.
 *
 * Rules return an i18n KEY, not a rendered string, for the same reason
 * `validateXrayConfig` does: a pure module cannot hold a `t`, and a test that
 * asserts on a key survives a copy edit to the message.
 */

/** The subset of the profile form a PQ rule reads. */
export interface PqFormValues {
  protocol: string;
  /** ML-DSA-65 only rides REALITY, so the pair is off under tls/none. */
  xraySecurity: string;
  /** VLESS-Encryption is a property of the vless account; trojan/vmess have none. */
  xraySubprotocol: string;
  xrayMldsa65Seed: string;
  xrayMldsa65Verify: string;
  xrayVlessDecryption: string;
  xrayVlessEncryption: string;
}

export type PqField =
  | 'xrayMldsa65Seed'
  | 'xrayMldsa65Verify'
  | 'xrayVlessDecryption'
  | 'xrayVlessEncryption';

/** Every field a PQ rule can put a message on. Exported so the form cannot
 *  wire three of the four and look complete. */
export const PQ_FIELDS: readonly PqField[] = [
  'xrayMldsa65Seed',
  'xrayMldsa65Verify',
  'xrayVlessDecryption',
  'xrayVlessEncryption',
];

/** Whitespace is not a value: an operator who pasted a trailing newline into
 *  one box and nothing into the other has still filled half a pair, and the
 *  submit builder trims before emitting, so the rules have to agree with it. */
const filled = (s: string): boolean => s.trim().length > 0;

/** ML-DSA-65 applies only to a REALITY xray profile. */
export function mldsaPairApplies(v: PqFormValues): boolean {
  return v.protocol === 'xray' && v.xraySecurity === 'reality';
}

/** VLESS-Encryption applies only to the vless subprotocol of an xray profile. */
export function vlessPairApplies(v: PqFormValues): boolean {
  return v.protocol === 'xray' && v.xraySubprotocol === 'vless';
}

/**
 * The message key for one field, or null when that field has nothing to say.
 *
 * A rule fires on the EMPTY field of a half-filled pair, so the error is
 * attached to the box the operator has to go fill.
 */
export function pqPairError(field: PqField, v: PqFormValues): string | null {
  switch (field) {
    case 'xrayMldsa65Verify':
      return mldsaPairApplies(v) && filled(v.xrayMldsa65Seed) && !filled(v.xrayMldsa65Verify)
        ? 'profiles.form.cfg.pqNeedsVerify'
        : null;
    case 'xrayMldsa65Seed':
      return mldsaPairApplies(v) && filled(v.xrayMldsa65Verify) && !filled(v.xrayMldsa65Seed)
        ? 'profiles.form.cfg.pqNeedsSeed'
        : null;
    case 'xrayVlessEncryption':
      return vlessPairApplies(v) && filled(v.xrayVlessDecryption) && !filled(v.xrayVlessEncryption)
        ? 'profiles.form.cfg.pqNeedsEncryption'
        : null;
    case 'xrayVlessDecryption':
      return vlessPairApplies(v) && filled(v.xrayVlessEncryption) && !filled(v.xrayVlessDecryption)
        ? 'profiles.form.cfg.pqNeedsDecryption'
        : null;
  }
}

/** Every field that currently has a complaint. Handy for asserting on a whole
 *  form state at once, and for anything that wants to know "is this savable". */
export function pqPairErrors(v: PqFormValues): Partial<Record<PqField, string>> {
  const out: Partial<Record<PqField, string>> = {};
  for (const field of PQ_FIELDS) {
    const key = pqPairError(field, v);
    if (key) out[field] = key;
  }
  return out;
}
