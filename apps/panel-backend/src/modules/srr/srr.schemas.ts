import { compileUaPattern, hasNestedQuantifier, splitInlineFlags } from '@iceslab/shared';
import { z } from 'zod';

// The formats a User-Agent rule may select. A SUBSET of SUBSCRIPTION_FORMATS
// (subscription.format-names.ts) on purpose: `amneziavpn` is a per-node vpn://
// artefact rather than a whole-subscription rendering, so no UA should resolve
// to it.
//
// `xrayjson-array` belongs here and was missing. It is the format the project
// added FOR Happ and V2RayTun - "Happ reads the single-config buildXrayJson as
// ONE server; this array is N standalone configs it reads as N servers"
// (xrayjson.test.ts) - and User-Agent matching is the only mechanism that puts
// a client on a format, since no client sends `?format=`. So the one format
// built for a named client could not be delivered to that client: the seeded
// rule for Happ had to fall back to `plain`, which carries no routing section
// at all, and the routing preset silently did not reach it. Measured on the
// live panel 2026-09-01 against `Happ/4.3.0/Android`: 768 bytes, zero geo
// rules, while Hiddify, v2rayNG and Clash all got theirs.
export const SrrFormat = z.enum([
  'plain',
  'json',
  'clash',
  'singbox',
  'wgconf',
  'xrayjson',
  'xrayjson-array',
  'xkeen',
  'outline',
  'surge',
  'quantumultx',
  'loon',
]);

/**
 * Which wg flavour `wgconf` should render for a matched client.
 *
 * Only `wgconf` renders wg at all, so this is meaningless on every other
 * format — and refused there (see the refinement below), because a flavour on a
 * `singbox` rule would read as a setting that does something.
 *
 * Optional on `wgconf` too. Left unset the builder keeps its old behaviour and
 * takes the first wg endpoint the subscription holds, which is right for an
 * install serving exactly one flavour and a coin-toss for one serving both.
 */
export const SrrProto = z.enum(['amneziawg', 'wireguard']);

const UaPatternField = z
  .string()
  .min(1)
  .max(512)
  .refine((v) => compileUaPattern(v) !== null, { message: 'Invalid regex pattern' })
  .refine((v) => !hasNestedQuantifier(splitInlineFlags(v).body), {
    message:
      'Pattern risks catastrophic backtracking (a nested quantifier like (a+)+); simplify it',
  });

export const CreateSrrSchema = z
  .object({
    name: z.string().min(1).max(64),
    uaPattern: UaPatternField,
    format: SrrFormat,
    proto: SrrProto.nullish(),
    priority: z.number().int().min(0).max(10000).optional().default(100),
    enabled: z.boolean().optional().default(true),
  })
  .superRefine(protoBelongsToFormat);

export type CreateSrrInput = z.infer<typeof CreateSrrSchema>;

export const UpdateSrrSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  uaPattern: UaPatternField.optional(),
  format: SrrFormat.optional(),
  // `null` clears the flavour, `undefined` leaves it. The pairing with `format`
  // cannot be judged here — a PUT may carry either one alone — so the route
  // checks the MERGED rule; see assertProtoMatchesFormat.
  proto: SrrProto.nullish(),
  priority: z.number().int().min(0).max(10000).optional(),
  enabled: z.boolean().optional(),
});

export type UpdateSrrInput = z.infer<typeof UpdateSrrSchema>;

/** A flavour only means something where a wg file is rendered. Anywhere else it
 *  is a field an operator can set and never see take effect, which is the shape
 *  of a setting people trust and then debug for an hour. */
function protoBelongsToFormat(
  value: { format?: string; proto?: string | null },
  ctx: z.RefinementCtx,
): void {
  if (value.proto && value.format !== 'wgconf') {
    ctx.addIssue({
      code: 'custom',
      path: ['proto'],
      message: `proto is only meaningful for the wgconf format, not "${value.format}"`,
    });
  }
}

/** The same rule applied to a rule after an update is merged into it. Throws
 *  the zod error the schema would have thrown, so the route reports both the
 *  same way. */
export function assertProtoMatchesFormat(merged: {
  format: string;
  proto: string | null;
}): void {
  const parsed = z
    .object({ format: z.string(), proto: z.string().nullable() })
    .superRefine(protoBelongsToFormat)
    .safeParse(merged);
  if (!parsed.success) throw parsed.error;
}

export const SrrIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const TestSrrSchema = z.object({
  /**
   * The User-Agent string to test against currently-enabled rules.
   * Returns the format that would be served, or `null` if no rule matched.
   */
  userAgent: z.string().min(1).max(512),
});

export type TestSrrInput = z.infer<typeof TestSrrSchema>;

/**
 * Kept under the name the SRR tests already import. The heuristic itself moved
 * to `shared` on 2026-08-28: the panel runs these patterns in the operator's
 * browser too, on every keystroke, and that side had no guard at all.
 */
export { hasNestedQuantifier };
