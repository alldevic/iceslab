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

const UaPatternField = z
  .string()
  .min(1)
  .max(512)
  .refine((v) => compileUaPattern(v) !== null, { message: 'Invalid regex pattern' })
  .refine((v) => !hasNestedQuantifier(splitInlineFlags(v).body), {
    message:
      'Pattern risks catastrophic backtracking (a nested quantifier like (a+)+); simplify it',
  });

export const CreateSrrSchema = z.object({
  name: z.string().min(1).max(64),
  uaPattern: UaPatternField,
  format: SrrFormat,
  priority: z.number().int().min(0).max(10000).optional().default(100),
  enabled: z.boolean().optional().default(true),
});

export type CreateSrrInput = z.infer<typeof CreateSrrSchema>;

export const UpdateSrrSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  uaPattern: UaPatternField.optional(),
  format: SrrFormat.optional(),
  priority: z.number().int().min(0).max(10000).optional(),
  enabled: z.boolean().optional(),
});

export type UpdateSrrInput = z.infer<typeof UpdateSrrSchema>;

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
