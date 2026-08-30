import { z } from 'zod';
import {
  PROTOCOL_CONFIG_SCHEMAS,
  type CreateInboundInput,
} from '../inbounds/inbounds.schemas.js';

// We reuse per-protocol config schemas from the old inbounds module, they
// describe the SHARED part of each profile's config and stay valid as
// `Profile.config`. Per-node fields (ACME domain, AmneziaWG private key,
// Shadowsocks server PSK, MTProto derived secret, ...) move to
// ProfileNodeBinding.overrides: see resolveBindingConfig() in profiles.service.

const NameSchema = z
  .string()
  .min(1, 'Name is required')
  .max(64, 'Name too long')
  .regex(/^[a-zA-Z0-9._-]+$/, 'Letters, digits, dot, underscore, hyphen');

const PortSchema = z.number().int().min(1).max(65535);

const PublicHostSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/,
    'Must be a valid hostname or IPv4',
  );

// Every protocol a profile can be. Must stay the shared ProtocolName union —
// see profiles.protocols.test.ts, which reads both sides rather than trusting
// this list: it had drifted, and the three sing-box-only protocols were
// missing from here and from the union below while the form offered all three.
export const ProtocolEnum = z.enum([
  'hysteria',
  'xray',
  'amneziawg',
  'wireguard',
  'naive',
  'shadowsocks',
  'mtproto',
  'mieru',
  // sing-box-only trio. Everything else about them already existed - the node
  // adapter, the inbound config schemas, credential fan-out, share links, and
  // the profile form that offers all three - but a profile could not be saved,
  // and deployment goes only through ProfileNodeBinding -> Profile. So they
  // were unreachable for an operator and untestable in the field (audit A-029).
  'tuic',
  'anytls',
  'shadowtls',
]);

// Engine-choice (EC5): which proxy core serves a profile. null = native.
export const EngineEnum = z.enum(['xray', 'hysteria', 'singbox']);

// Which engines each protocol may be served by. The shared protocols can run on
// their native core OR sing-box; everything else has a single native core, so
// its engine must stay null (native).
const ENGINE_OPTIONS: Record<string, readonly string[]> = {
  xray: ['xray', 'singbox'],
  shadowsocks: ['xray', 'singbox'],
  hysteria: ['hysteria', 'singbox'],
  // sing-box is not one option among several for these three, it is the only
  // core that speaks them. Listing it anyway is what lets an operator SAY so:
  // without an entry here the protocol saves only with a null engine, and a
  // form that sends `engine: 'singbox'` is refused with a message about an
  // invalid engine, which reads as "this protocol is broken".
  tuic: ['singbox'],
  anytls: ['singbox'],
  shadowtls: ['singbox'],
};

/**
 * Fork-only config features the sing-box engine cannot render, listed by the
 * config key that carries them.
 *
 * The sing-box adapter decodes a narrow subset of the xray inbound config
 * (xrayFamilyWire), so any key it does not know silently disappears: the push
 * succeeds, the node comes up healthy, and the feature the panel shows as
 * enabled is simply not there. For an anti-abuse policy that means a node
 * enforcing nothing; for post-quantum REALITY it means a profile advertised as
 * post-quantum running classical X25519; for a REALITY fallback throttle it
 * means a prober that fails auth is forwarded at full speed. The node-agent
 * rejects every key listed here, and this is the panel half of the same guard
 * so the operator hears about it while saving rather than after the push.
 *
 * WARP egress belongs to the same family and is deliberately NOT here, because
 * it cannot be: the panel attaches it per NODE at push time, so no profile
 * config ever carries it. Its guard is in inbounds.queue (which xray inbound is
 * allowed to receive it) plus the node-agent.
 *
 * abusePolicy rides both the xray and the shadowsocks config, and the sing-box
 * engine serves both, so the check is keyed on the config keys rather than on
 * the protocol.
 *
 * Returns the offending keys (empty when the pair is fine).
 */
export function fieldsUnsupportedByEngine(
  engine: string | null | undefined,
  config: unknown,
): string[] {
  if (engine !== 'singbox' || config == null || typeof config !== 'object') return [];
  const cfg = config as Record<string, unknown>;
  const offending: string[] = [];
  if (cfg.abusePolicy != null) offending.push('abusePolicy');
  if (cfg.realityMldsa65Seed) offending.push('realityMldsa65Seed');
  if (cfg.vlessDecryption) offending.push('vlessDecryption');
  // xray writes these three into realitySettings (`xver`,
  // `limitFallbackUpload/Download`); sing-box's tls.reality block has no
  // equivalent, so before this list knew them the form saved them, the panel
  // showed them set, the push succeeded and the node held none of them.
  // Measured on a lab node 2026-08-30 with xver=2 and both throttles set: the
  // rendered sing-box config carried no trace of any of the three.
  //
  // Zero is the "off" value for all three, so only a set value is a promise.
  if (Number(cfg.realityXver) > 0) offending.push('realityXver');
  if (Number(cfg.realityLimitFallbackUploadBytesPerSec) > 0) {
    offending.push('realityLimitFallbackUploadBytesPerSec');
  }
  if (Number(cfg.realityLimitFallbackDownloadBytesPerSec) > 0) {
    offending.push('realityLimitFallbackDownloadBytesPerSec');
  }
  return offending;
}

/** A null/undefined engine (native) is always valid; a set engine must be one
 *  of the protocol's allowed cores. */
export function engineValidForProtocol(
  protocol: string,
  engine: string | null | undefined,
): boolean {
  if (!engine) return true;
  return (ENGINE_OPTIONS[protocol] ?? []).includes(engine);
}

// Discriminated union, same shape as the old InboundConfigByProtocol but
// without the per-node `nodeId/port/publicHost` fields. Profile holds the
// shared template only.
const ProfileConfigByProtocol = z.discriminatedUnion('protocol', [
  z.object({ protocol: z.literal('hysteria'),    config: PROTOCOL_CONFIG_SCHEMAS.hysteria }),
  z.object({ protocol: z.literal('xray'),        config: PROTOCOL_CONFIG_SCHEMAS.xray }),
  z.object({ protocol: z.literal('amneziawg'),   config: PROTOCOL_CONFIG_SCHEMAS.amneziawg }),
  z.object({ protocol: z.literal('wireguard'),   config: PROTOCOL_CONFIG_SCHEMAS.wireguard }),
  z.object({ protocol: z.literal('naive'),       config: PROTOCOL_CONFIG_SCHEMAS.naive }),
  z.object({ protocol: z.literal('shadowsocks'), config: PROTOCOL_CONFIG_SCHEMAS.shadowsocks }),
  z.object({ protocol: z.literal('mtproto'),     config: PROTOCOL_CONFIG_SCHEMAS.mtproto }),
  z.object({ protocol: z.literal('mieru'),       config: PROTOCOL_CONFIG_SCHEMAS.mieru }),
  z.object({ protocol: z.literal('tuic'),        config: PROTOCOL_CONFIG_SCHEMAS.tuic }),
  z.object({ protocol: z.literal('anytls'),      config: PROTOCOL_CONFIG_SCHEMAS.anytls }),
  z.object({ protocol: z.literal('shadowtls'),   config: PROTOCOL_CONFIG_SCHEMAS.shadowtls }),
]);

const ProfileBaseFields = z.object({
  name: NameSchema,
  description: z.string().max(500).nullish(),
  enabled: z.boolean().default(true),
  /** Engine-choice (EC5): null/omitted = native core, 'singbox' = sing-box. */
  engine: EngineEnum.nullish(),
});

export const CreateProfileSchema = z
  .intersection(ProfileBaseFields, ProfileConfigByProtocol)
  .superRefine((val, ctx) => {
    if (!engineValidForProtocol(val.protocol, val.engine ?? null)) {
      ctx.addIssue({
        code: 'custom',
        message: `engine "${val.engine}" is not valid for protocol "${val.protocol}"`,
        path: ['engine'],
      });
    }
    for (const field of fieldsUnsupportedByEngine(val.engine, val.config)) {
      ctx.addIssue({
        code: 'custom',
        message: `${field} is not supported by the sing-box engine (use the xray engine)`,
        path: ['config', field],
      });
    }
  });
export type CreateProfileInput = z.infer<typeof CreateProfileSchema>;

// Profile updates never change the protocol (would invalidate every
// binding's overrides). To switch protocol, delete + recreate.
export const UpdateProfileSchema = z.object({
  name: NameSchema.optional(),
  description: z.string().max(500).nullable().optional(),
  enabled: z.boolean().optional(),
  /** Engine-choice (EC5). Validated against the profile's protocol in service. */
  engine: EngineEnum.nullable().optional(),
  /** Must match the profile's existing protocol. Validated in service. */
  config: z.unknown().optional(),
});
export type UpdateProfileInput = z.infer<typeof UpdateProfileSchema>;

// ───── Bindings ─────

export const CreateBindingSchema = z.object({
  profileId: z.uuid(),
  nodeId: z.uuid(),
  port: PortSchema,
  publicHost: PublicHostSchema.optional()
    .or(z.literal('').transform(() => undefined))
    .optional(),
  publicPort: PortSchema.optional(),
  /** Per-node overrides over Profile.config. Validated by the protocol's
   *  config schema (partial). */
  overrides: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().default(true),
});
export type CreateBindingInput = z.infer<typeof CreateBindingSchema>;

export const UpdateBindingSchema = z.object({
  port: PortSchema.optional(),
  publicHost: PublicHostSchema.nullable()
    .or(z.literal('').transform(() => null))
    .optional(),
  publicPort: PortSchema.nullable().optional(),
  overrides: z.record(z.string(), z.unknown()).nullable().optional(),
  enabled: z.boolean().optional(),
});
export type UpdateBindingInput = z.infer<typeof UpdateBindingSchema>;

export const BulkBindSchema = z.object({
  /** Bind this profile to all of these nodes in one call. Existing bindings
   *  for the same (profile, node) pair are skipped, idempotent. */
  profileId: z.uuid(),
  nodeIds: z.array(z.uuid()).min(1).max(100),
  port: PortSchema,
});
export type BulkBindInput = z.infer<typeof BulkBindSchema>;

// ───── Common ─────

export const ProfileIdParamSchema = z.object({ id: z.uuid() });
export const BindingIdParamSchema = z.object({ id: z.uuid() });

export const ListProfilesQuerySchema = z.object({
  protocol: ProtocolEnum.optional(),
});
export type ListProfilesQuery = z.infer<typeof ListProfilesQuerySchema>;

export const ListBindingsQuerySchema = z.object({
  nodeId: z.uuid().optional(),
  profileId: z.uuid().optional(),
});
export type ListBindingsQuery = z.infer<typeof ListBindingsQuerySchema>;

// Re-export for convenience
export type { CreateInboundInput };
