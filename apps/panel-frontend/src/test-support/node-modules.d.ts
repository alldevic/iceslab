/**
 * The two Node modules a backend schema file reaches: node:v8 (srr/linear-regex.ts,
 * imported by srr.schemas.ts) and node:net (cascades/policy-entries.ts, imported by
 * node-policies.schemas.ts). The app's tsconfig has no `node` types on purpose, so
 * that app code cannot reach for them; a declaration of the single function used
 * from each keeps it that way. Vitest runs under Node and resolves the real modules.
 */
declare module 'node:v8' {
  export function setFlagsFromString(flags: string): void;
}
declare module 'node:net' {
  export function isIP(input: string): 0 | 4 | 6;
}
