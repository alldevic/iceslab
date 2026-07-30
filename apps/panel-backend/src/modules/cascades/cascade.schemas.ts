import { z } from 'zod';

// Max hops in a single cascade. Each hop adds latency + an inter-hop link
// (UFW port LINK_PORT_BASE+i), so the chain is capped. Enforced at the schema
// edge (early 400) AND in validateCascadeHops (defensive), and mirrored in the
// frontend cascade builder (the "Add hop" button stops here). Positions are
// 0..MAX_CASCADE_HOPS-1.
export const MAX_CASCADE_HOPS = 5;

// The full 7-core protocol set. Stored as free strings on the hop; the
// node-agent realises each entry/link cell native-first (xray entry ->
// vless/ss2022/wg links), bridges later. See docs/ROADMAP.md "C. Каскады".
export const CascadeProtocol = z.enum([
  'xray',
  'hysteria',
  'amneziawg',
  'naive',
  'shadowsocks',
  'mtproto',
  'mieru',
]);

export const CascadeHopSchema = z.object({
  nodeId: z.uuid(),
  /** 0 = entry, highest = exit. Must be contiguous 0..N-1 across the cascade. */
  position: z.number().int().min(0).max(MAX_CASCADE_HOPS - 1),
  /** Client-facing protocol; only valid on the entry hop. */
  entryProtocol: CascadeProtocol.optional(),
  /** Protocol to the NEXT hop; omitted on the exit hop. */
  linkProtocol: CascadeProtocol.optional(),
});

/** 'chain' = sequential entry->...->exit (default/legacy). 'balancer' = one
 *  entry that latency-balances across N parallel exits (the "auto" node): hop
 *  position 0 is the entry, every hop position >=1 is a parallel exit. */
export const CascadeMode = z.enum(['chain', 'balancer']);

// ───── v4 shape (what the redesigned screens send) ─────
//
// The panel was rebuilt around positions and directions: a position is a step
// of the path holding a POOL of interchangeable nodes, a direction is a way out
// carrying a frozen tag. The storage model behind this endpoint is still the
// older one, where a cascade is an ordered list of single-node hops.
//
// Rather than block the screens until storage catches up, this accepts the new
// shape and folds it into the old one whenever the topology is expressible
// there. Everything E1 shipped is: one entry plus one exit is a chain, one
// entry plus N exits is a balancer. What does NOT fit is rejected by name, so
// an operator learns the limit instead of watching a button stay dead:
//
//   - more than one node on a position (a pool) needs the new storage;
//   - transits combined with several directions had no representation at all
//     in the old model, which is precisely why the rewrite exists.
export const CascadePositionSchema = z.object({
  nodeIds: z.array(z.uuid()).min(1),
  position: z.number().int().min(0).max(MAX_CASCADE_HOPS - 1),
  entryProtocol: CascadeProtocol.optional(),
  linkProtocol: CascadeProtocol.optional(),
});

export const CascadeDirectionSchema = z.object({
  /** Ignored on input: the tag is derived from the exit's position, exactly as
   *  the current generator does. Accepted so the client can round-trip its own
   *  payload without stripping fields. */
  tag: z.number().int().optional(),
  countryCode: z.string().length(2).nullish(),
  nodeIds: z.array(z.uuid()).min(1),
});

const CascadeBaseFields = {
  name: z.string().min(1).max(64),
  enabled: z.boolean().default(true),
  /** When true (default), hide the cascade's non-entry (exit/transit) nodes
   *  from the raw subscription; uncheck to also expose them as direct picks. */
  hideHopsFromSub: z.boolean().default(true),
};

export const CreateCascadeSchema = z
  .object({
    ...CascadeBaseFields,
    mode: CascadeMode.default('chain'),
    hops: z.array(CascadeHopSchema).min(2).max(MAX_CASCADE_HOPS).optional(),
    positions: z.array(CascadePositionSchema).min(1).max(MAX_CASCADE_HOPS).optional(),
    directions: z.array(CascadeDirectionSchema).min(1).optional(),
  })
  .superRefine((val, ctx) => {
    const hasV4 = val.positions !== undefined || val.directions !== undefined;
    if (!hasV4 && !val.hops) {
      ctx.addIssue({ code: 'custom', message: 'hops, or positions + directions, is required', path: ['hops'] });
      return;
    }
    if (hasV4 && (val.positions === undefined || val.directions === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'positions and directions must be sent together',
        path: [val.positions === undefined ? 'positions' : 'directions'],
      });
    }
  });

export const UpdateCascadeSchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    enabled: z.boolean().optional(),
    mode: CascadeMode.optional(),
    hideHopsFromSub: z.boolean().optional(),
    hops: z.array(CascadeHopSchema).min(2).max(MAX_CASCADE_HOPS).optional(),
    positions: z.array(CascadePositionSchema).min(1).max(MAX_CASCADE_HOPS).optional(),
    directions: z.array(CascadeDirectionSchema).min(1).optional(),
  })
  .superRefine((val, ctx) => {
    if ((val.positions === undefined) !== (val.directions === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'positions and directions must be sent together',
        path: [val.positions === undefined ? 'positions' : 'directions'],
      });
    }
  });

export const CascadeIdParamSchema = z.object({ id: z.uuid() });

export type CascadeHopInput = z.infer<typeof CascadeHopSchema>;
export type CascadePositionInput = z.infer<typeof CascadePositionSchema>;
export type CascadeDirectionInput = z.infer<typeof CascadeDirectionSchema>;
export type CreateCascadeInput = z.infer<typeof CreateCascadeSchema>;
export type UpdateCascadeInput = z.infer<typeof UpdateCascadeSchema>;
