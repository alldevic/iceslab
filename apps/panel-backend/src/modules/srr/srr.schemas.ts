import { z } from 'zod';
import { FORMAT_NAMES } from '@iceslab/shared';
import { compileLinearRule } from './linear-regex.js';

/**
 * Which format a rule may serve.
 *
 * ⚠ The SHARED list. This was its own copy of eleven names, missing
 * `xrayjson-array` and `amneziavpn`, so an operator could not write a rule for
 * two formats the subscription hands out every day: the route served them, the
 * rule editor refused them, and nothing said why (issue #41).
 *
 * A rule naming a format is only ever a NARROWING of what /sub already does, so
 * this list has no reason to be smaller than the one /sub accepts.
 */
export const SrrFormat = z.enum(FORMAT_NAMES);

/**
 * Why a pattern cannot be a rule, or null when it can. It is compiled exactly as
 * a request compiles it (compileLinearRule, A-019): on V8's linear engine, so a
 * rule saved here runs in time linear in the User-Agent whatever its shape.
 * The engine refuses at compile time what it cannot run that way, and that is
 * the refusal here, in words an operator can act on.
 *
 * The heuristic that stood here (a quantifier inside a quantified group) is
 * gone with the backtracking it guarded against: it let `^(\w|\d)+$` through,
 * which did not finish in two minutes on 31 characters, and refused
 * `(\d+\.)+`, which the linear engine runs in microseconds.
 */
export function ruleProblem(value: string): string | null {
  try {
    compileLinearRule(value);
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.includes('linear time')
      ? 'Pattern uses a backreference or a lookahead, which User-Agent rules do not support; rewrite it without'
      : 'Invalid regex pattern';
  }
}

const UaPatternField = z
  .string()
  .min(1)
  .max(512)
  .superRefine((v, ctx) => {
    const problem = ruleProblem(v);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

const TemplateNameField = z.string().trim().min(1).max(64);

export const CreateSrrSchema = z.object({
  name: z.string().min(1).max(64),
  uaPattern: UaPatternField,
  format: SrrFormat,
  priority: z.number().int().min(0).max(10000).optional().default(100),
  enabled: z.boolean().optional().default(true),
  /** A-236: the operator template the matched clients are framed by, of the
   *  type the format is framed by; null or absent = the Default. Checked
   *  against the templates in the route. */
  templateName: TemplateNameField.nullish(),
});

export type CreateSrrInput = z.infer<typeof CreateSrrSchema>;

export const UpdateSrrSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  uaPattern: UaPatternField.optional(),
  format: SrrFormat.optional(),
  priority: z.number().int().min(0).max(10000).optional(),
  enabled: z.boolean().optional(),
  // Absent = not an edit; null = back to the Default.
  templateName: TemplateNameField.nullable().optional(),
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
