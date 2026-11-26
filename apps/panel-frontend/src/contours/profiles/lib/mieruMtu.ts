/**
 * The mieru MTU the form offers: the bounds the schema (MieruConfigSchema) and
 * the node enforce, and the default. Held to the backend source by
 * profileRules.mirror.test.ts.
 */
export const MIERU_MTU = { min: 1280, max: 1500, default: 1400 } as const;
