import { describe, expect, it } from 'vitest';
import {
  interfaceFields,
  interfaceOptionalFields,
  interfaceParents,
  zodObjectKeys,
} from './declarations';

// The parser's own control: without it the mirrors could pass on emptiness.
// The fixture carries every shape the real files use, plus the ones that would
// fool a line-based reader.
const FIXTURE = `
export interface Sample extends Base<string>, Other {
  id: string;
  /** A doc comment mentioning notAField: string; which is prose, not a member. */
  name: string | null;
  // notAField: number;
  nested?: { inner: string; deeper: { x: number } };
  union: 'a' | 'b' | 'c';
  list: Array<{ k: string }>;
  fn: (arg: string) => void;
  url: 'http://x.y' | null; // trailing comment: notAField2: 1
  multi: {
    across: string;
    lines: number;
  };
  readonly last?: boolean
}

export interface Other {
  decoy: string;
}

export const Shape = z.object({
  a: z.string(),
  // gone: z.string(),
  b: z.object({ inner: z.number() }).optional(),
  c: z.array(z.object({ deep: z.string() })),
  d: z
    .number()
    .int(),
});
`;

describe('interfaceFields', () => {
  it('reads the top-level members and nothing else', () => {
    expect(interfaceFields(FIXTURE, 'Sample')).toEqual([
      'id', 'name', 'nested', 'union', 'list', 'fn', 'url', 'multi', 'last',
    ]);
  });

  it('stops at the closing brace instead of running into the next interface', () => {
    expect(interfaceFields(FIXTURE, 'Sample')).not.toContain('decoy');
    expect(interfaceFields(FIXTURE, 'Other')).toEqual(['decoy']);
  });

  it('does not take the name of a longer interface for the one asked', () => {
    expect(() => interfaceFields('interface SampleX { a: 1 }', 'Sample')).toThrow(/not found/);
  });

  it('throws rather than returning nothing when the interface is gone', () => {
    expect(() => interfaceFields(FIXTURE, 'Missing')).toThrow(/not found/);
  });
});

describe('interfaceOptionalFields and interfaceParents', () => {
  it('names the optional members', () => {
    expect(interfaceOptionalFields(FIXTURE, 'Sample')).toEqual(['nested', 'last']);
  });

  it('names the parents, without type arguments', () => {
    expect(interfaceParents(FIXTURE, 'Sample')).toEqual(['Base', 'Other']);
    expect(interfaceParents(FIXTURE, 'Other')).toEqual([]);
    expect(() => interfaceParents(FIXTURE, 'Missing')).toThrow(/not found/);
  });
});

describe('zodObjectKeys', () => {
  it('reads the top-level keys, through nested objects, comments and chains', () => {
    expect(zodObjectKeys(FIXTURE, 'Shape')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('throws when the constant is gone or is not a z.object literal', () => {
    expect(() => zodObjectKeys(FIXTURE, 'Nope')).toThrow(/not found/);
    expect(() => zodObjectKeys('const Shape = z.object({});', 'Shape')).toThrow(/no keys/);
  });
});
