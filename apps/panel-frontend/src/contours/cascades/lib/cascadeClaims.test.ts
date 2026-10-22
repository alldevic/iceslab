import { describe, expect, it } from 'vitest';
import { cascadeClaims } from '@/contours/cascades/lib/cascadeClaims';
import type { Cascade } from '@/lib/domain/cascades';

type C = Parameters<typeof cascadeClaims>[0][number];
const pos = (position: number, nodeIds: string[]) => ({ position, nodeIds }) as Cascade['positions'][number];
const dir = (nodeIds: string[]) => ({ nodeIds }) as Cascade['directions'][number];
const hop = (nodeId: string) => ({ nodeId }) as Cascade['hops'][number];

const v4: C = {
  id: 'c1',
  name: 'first',
  hops: [],
  positions: [pos(0, ['x', 'y']), pos(1, ['t'])],
  directions: [dir(['d1']), dir([])],
};
const old: C = { id: 'c2', name: 'legacy', hops: [hop('h1'), hop('h2')], positions: [], directions: [] };

describe('cascadeClaims (A-139)', () => {
  it('v4-каскад с пулом на входе: каждая нода входа, транзита и направления занята им', () => {
    const m = cascadeClaims([v4]);
    expect(['x', 'y', 't', 'd1'].map((id) => m.get(id))).toEqual(['first', 'first', 'first', 'first']);
    expect(m.size).toBe(4);
  });

  it('старый каскад по хопам читается как раньше', () => {
    expect(cascadeClaims([old]).get('h2')).toBe('legacy');
  });

  it('редактируемый каскад своих нод не занимает', () => {
    const m = cascadeClaims([v4, old], 'c1');
    expect(m.has('x')).toBe(false);
    expect(m.get('h1')).toBe('legacy');
  });

  it('направление на именованном выходе без нод ничего не занимает', () => {
    expect(cascadeClaims([{ ...v4, positions: [], directions: [dir([])] }]).size).toBe(0);
  });
});
