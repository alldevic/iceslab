import { z } from 'zod';
import { EgressPolicySchema } from './cascade.geo.js';

// Max hops in a single cascade. Each hop adds latency + an inter-hop link
// (UFW port LINK_PORT_BASE+i), so the chain is capped. Enforced at the schema
// edge (early 400) AND in validateCascadeHops (defensive), and mirrored in the
// frontend cascade builder (the "Add hop" button stops here). Positions are
// 0..MAX_CASCADE_HOPS-1.
export const MAX_CASCADE_HOPS = 5;

// The full 7-core protocol set. Stored as free strings on the hop; the
// node-agent realises each entry/link cell native-first (xray entry ->
// vless/ss2022/wg links), bridges later. See docs/ROADMAP.md "C. Каскады".
const CASCADE_PROTOCOLS = [
  'xray',
  'hysteria',
  'amneziawg',
  'naive',
  'shadowsocks',
  'mtproto',
  'mieru',
] as const;
export const CascadeProtocol = z.enum(CASCADE_PROTOCOLS);

// The inter-hop LINK protocol is a different vocabulary from the entry protocol:
// the only realised link cells are the raw `vless` link (C3, the historical
// default) and `shadowsocks`/SS2022 (C3b); the node normalises anything else to
// vless (see cascade.config.ts normalizeLinkProtocol). Validating linkProtocol
// with the entry enum wrongly REJECTED 'vless' (which the seed and every legacy
// cascade store), so editing such a cascade 400'd. Accept the core set PLUS
// 'vless' so no stored value is refused, while the UI offers the two real cells.
export const CascadeLinkProtocol = z.enum([...CASCADE_PROTOCOLS, 'vless']);

export const CascadeHopSchema = z.object({
  nodeId: z.uuid(),
  /** 0 = entry, highest = exit. Must be contiguous 0..N-1 across the cascade. */
  position: z.number().int().min(0).max(MAX_CASCADE_HOPS - 1),
  /** Client-facing protocol; only valid on the entry hop. */
  entryProtocol: CascadeProtocol.optional(),
  /** Protocol to the NEXT hop; omitted on the exit hop. */
  linkProtocol: CascadeLinkProtocol.optional(),
});

/** 'chain' = sequential entry->...->exit (default/legacy). 'balancer' = one
 *  entry that latency-balances across N parallel exits (the "auto" node): hop
 *  position 0 is the entry, every hop position >=1 is a parallel exit. */
export const CascadeMode = z.enum(['chain', 'balancer']);

export const CreateCascadeSchema = z.object({
  name: z.string().min(1).max(64),
  enabled: z.boolean().default(true),
  mode: CascadeMode.default('chain'),
  /** When true (default), hide the cascade's non-entry (exit/transit) nodes
   *  from the raw subscription; uncheck to also expose them as direct picks. */
  hideHopsFromSub: z.boolean().default(true),
  hops: z.array(CascadeHopSchema).min(2).max(MAX_CASCADE_HOPS),
  /** E - server-side geo split applied on the ENTRY hop (category/literal ->
   *  direct/block/link-out). Omitted = no split (byte-identical cascade). */
  egressPolicy: EgressPolicySchema.optional(),
});

export const UpdateCascadeSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
  mode: CascadeMode.optional(),
  hideHopsFromSub: z.boolean().optional(),
  hops: z.array(CascadeHopSchema).min(2).max(MAX_CASCADE_HOPS).optional(),
  /** Pass [] to clear the policy; omit to leave it unchanged. */
  egressPolicy: EgressPolicySchema.optional(),
});

export const CascadeIdParamSchema = z.object({ id: z.uuid() });

export type CascadeHopInput = z.infer<typeof CascadeHopSchema>;
export type CreateCascadeInput = z.infer<typeof CreateCascadeSchema>;
export type UpdateCascadeInput = z.infer<typeof UpdateCascadeSchema>;
