import type { FormValues } from '@/contours/profiles/lib/profileFormValues';
import { awgKeyProblem } from '@/contours/profiles/lib/awgRules';

/**
 * The plain WireGuard rules the schema enforces on a profile, said on the form
 * before the request (milestone 9.3):
 *
 *  - the subnet is a dotted quad with a prefix, `10.77.77.0/24`
 *    (WireguardConfigSchema's `subnet` pattern);
 *  - each server key is 44 characters of standard base64 ending in `=`, the
 *    same shape AmneziaWG has (awgKeyProblem, the schema's WG_KEY_PATTERN).
 *
 * There is no obfuscation to check. Held to the backend by
 * profileRules.mirror.test.ts.
 */
export const WG_SUBNET_RE = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;

export type WireguardRuleField = 'wgSubnet' | 'wgServerPriv' | 'wgServerPub';

type WireguardRuleValues = Pick<FormValues, 'wgSubnet' | 'wgServerPriv' | 'wgServerPub'>;

/** The fields that break a rule. */
export function wireguardRuleProblems(values: WireguardRuleValues): Set<WireguardRuleField> {
  const bad = new Set<WireguardRuleField>();
  if (!WG_SUBNET_RE.test(values.wgSubnet)) bad.add('wgSubnet');
  if (awgKeyProblem(values.wgServerPriv)) bad.add('wgServerPriv');
  if (awgKeyProblem(values.wgServerPub)) bad.add('wgServerPub');
  return bad;
}

/** The i18n key of the words under each field. */
export const WIREGUARD_RULE_WORDS: Record<WireguardRuleField, string> = {
  wgSubnet: 'profiles.form.cfg.wgSubnetShape',
  wgServerPriv: 'profiles.form.cfg.awgKeyShape',
  wgServerPub: 'profiles.form.cfg.awgKeyShape',
};
