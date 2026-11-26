import type { FormValues } from '@/contours/profiles/lib/profileFormValues';

/**
 * The AmneziaWG rules the schema and the node enforce beyond a field's own
 * bounds, said on the form before the request (milestone 6.5):
 *
 *  - Jmin <= Jmax (node validate(); the schema's `jmax` issue);
 *  - S1 + 56 != S2, which would make the handshake the length of vanilla
 *    WireGuard's (schema `s2` issue);
 *  - each server key is 44 characters of standard base64 ending in `=`
 *    (validateWGKey on the node, WG_KEY_PATTERN in the schema).
 *
 * An empty Jmin, Jmax, S1 or S2 is read as the default the save sends for it
 * (profileConfig), so the rules judge what would be sent. The headers are
 * awgHeaders.ts. Held to the backend by awgRules.mirror.test.ts.
 */
export const AWG_RULE_FIELDS = ['awgJmax', 'awgS2', 'awgServerPriv', 'awgServerPub'] as const;

/** Same pattern as the schema's WG_KEY_PATTERN. */
export const WG_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

/** The 56 of the S1 + 56 rule: the length gap that spells vanilla WireGuard. */
export const AWG_S_GAP = 56;

const DEFAULTS = { jmin: 64, jmax: 128, s1: 32, s2: 56 } as const;

type Num = number | '' | null | undefined;
const num = (v: Num, fallback: number): number => (v === '' || v === null || v === undefined ? fallback : Number(v));

export type AwgRuleField = 'awgJmax' | 'awgS2' | 'awgServerPriv' | 'awgServerPub';

export function awgKeyProblem(key: string | null | undefined): boolean {
  return !WG_KEY_RE.test(key ?? '');
}

/** Jmin above Jmax. */
export function awgJunkProblem(jmin: Num, jmax: Num): boolean {
  return num(jmin, DEFAULTS.jmin) > num(jmax, DEFAULTS.jmax);
}

/** S1 + 56 equal to S2. */
export function awgPaddingProblem(s1: Num, s2: Num): boolean {
  return num(s1, DEFAULTS.s1) + AWG_S_GAP === num(s2, DEFAULTS.s2);
}

type AwgRuleValues = Pick<FormValues, 'awgJmin' | 'awgJmax' | 'awgS1' | 'awgS2' | 'awgServerPriv' | 'awgServerPub'>;

/** The fields that break a rule: Jmin > Jmax marks Jmax, S1 + 56 = S2 marks
 *  S2, a key of the wrong shape marks that key. */
export function awgRuleProblems(values: AwgRuleValues): Set<AwgRuleField> {
  const bad = new Set<AwgRuleField>();
  if (awgJunkProblem(values.awgJmin, values.awgJmax)) bad.add('awgJmax');
  if (awgPaddingProblem(values.awgS1, values.awgS2)) bad.add('awgS2');
  if (awgKeyProblem(values.awgServerPriv)) bad.add('awgServerPriv');
  if (awgKeyProblem(values.awgServerPub)) bad.add('awgServerPub');
  return bad;
}

/** The i18n key of the words under each field. */
export const AWG_RULE_WORDS: Record<AwgRuleField, string> = {
  awgJmax: 'profiles.form.cfg.awgJunkOrder',
  awgS2: 'profiles.form.cfg.awgPaddingGap',
  awgServerPriv: 'profiles.form.cfg.awgKeyShape',
  awgServerPub: 'profiles.form.cfg.awgKeyShape',
};
