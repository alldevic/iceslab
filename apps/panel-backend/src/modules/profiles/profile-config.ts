import { PROTOCOL_CONFIG_SCHEMAS } from '../inbounds/inbounds.schemas.js';
import { stripInapplicableTransportFields } from '../inbounds/xray-transport-fields.js';
import { generateSsServerPsk, ssKeyLengthFor } from './ss-helpers.js';

/**
 * Config keys of a profile that no editor renders, per protocol.
 *
 * A profile update REPLACES `config`, and the only editor of a profile rebuilds
 * it from the controls it draws. Every key below therefore left the record the
 * moment an operator pressed Save on an unrelated field — measured 2026-08-29
 * against the live panel: renaming a shadowsocks profile came back with
 * `{"method": "..."}` and nothing else.
 *
 * The node form had already made this decision correctly for its own blob
 * ("a node update REPLACES hardening, so building it from the four toggles
 * alone [loses the rest]"); this is the neighbour where it was never made.
 *
 * `mint` marks the ones the panel generates: nobody has them written down, so
 * absent has to mean "make one", not "leave it empty". `fits` guards the carry
 * across a cipher change, where a key of the previous length is one both cores
 * refuse.
 *
 * Deliberately a short explicit list rather than "preserve whatever the request
 * omitted": the xray branch of the form emits its optional fields conditionally,
 * so for those an omission is how an operator CLEARS one, and blanket
 * preservation would make them unclearable.
 */
interface PanelOwnedKey {
  key: string;
  /** Config key naming the cipher, for the two that hold a shadowsocks key. */
  methodKey?: string;
  mint?: (config: Record<string, unknown>) => string;
  fits?: (value: string, config: Record<string, unknown>) => boolean;
}

const ssKey = (key: string, methodKey: string): PanelOwnedKey => ({
  key,
  methodKey,
  mint: (cfg) => generateSsServerPsk(String(cfg[methodKey] ?? '')),
  fits: (v, cfg) => Buffer.from(v, 'base64').length === ssKeyLengthFor(String(cfg[methodKey] ?? '')),
});

export const PANEL_OWNED_CONFIG_KEYS: Record<string, PanelOwnedKey[]> = {
  // The inner shadowsocks server key. Both node adapters refuse an inbound
  // without one ("shadowsocks serverPsk is required", "shadowtls ssPassword
  // (inner shadowsocks key) is required"), and no form shows a secret.
  shadowsocks: [
    ssKey('serverPsk', 'method'),
    // U4 anti-abuse. The shadowsocks core renders the same BLOCK rules as xray
    // and the schema carries the same policy, but the toggles live in the xray
    // advanced tabs only, so for a shadowsocks profile this can arrive over the
    // API and has no control to send it back.
    { key: 'abusePolicy' },
  ],
  shadowtls: [ssKey('ssPassword', 'ssMethod')],
  // Hysteria's ACME name. The sync queue derives it from the node's address on
  // every push, so on a node dialled by name it is rewritten anyway - but on an
  // IP-addressed node `acmeHostnameFor` returns null and whatever the profile
  // holds is what the node gets.
  hysteria: [{ key: 'hostname' }],
};

/**
 * Carry the panel-owned keys of a profile config across a save, minting the
 * ones that have a generator when there is nothing to carry.
 */
export function keepPanelOwnedKeys(
  protocol: string,
  config: Record<string, unknown>,
  previous?: unknown,
): Record<string, unknown> {
  const owned = PANEL_OWNED_CONFIG_KEYS[protocol];
  if (!owned) return config;
  const prev = (previous ?? {}) as Record<string, unknown>;
  const out = { ...config };
  for (const spec of owned) {
    if (out[spec.key] != null && out[spec.key] !== '') continue;
    const carried = prev[spec.key];
    const usable =
      carried != null &&
      carried !== '' &&
      (spec.fits == null || (typeof carried === 'string' && spec.fits(carried, out)));
    if (usable) out[spec.key] = carried;
    else if (spec.mint) out[spec.key] = spec.mint(out);
  }
  return out;
}

/**
 * What a profile config becomes when it is SAVED — the single pipeline both
 * create and update run, in that order:
 *
 *  1. the protocol's own schema, so defaults are filled in;
 *  2. the panel-owned keys, carried over or minted, so an omission by a form
 *     that cannot draw them is never a deletion;
 *  3. for xray, the transport sweep, so fields belonging to a transport this
 *     profile no longer uses do not come back to life later.
 *
 * One function because create and update kept answering the same question
 * differently: create minted a `serverPsk` and update dropped it, so renaming a
 * shadowsocks profile deleted a secret nobody could retype. Two call sites, one
 * decision.
 *
 * Free of prisma on purpose: the panel-frontend round-trip test imports THIS to
 * ask what an edit really stores, rather than restating the rules in a fixture
 * that would go stale in exactly the direction that hides the next bug.
 */
export function normalizeProfileConfigForSave(
  protocol: string,
  config: unknown,
  previous?: unknown,
): Record<string, unknown> {
  const schema = PROTOCOL_CONFIG_SCHEMAS[protocol as keyof typeof PROTOCOL_CONFIG_SCHEMAS];
  if (!schema) throw new Error(`Unknown protocol ${protocol}`);
  const parsed = schema.parse(config) as Record<string, unknown>;
  const kept = keepPanelOwnedKeys(protocol, parsed, previous);
  return protocol === 'xray' ? stripInapplicableTransportFields(kept) : kept;
}
