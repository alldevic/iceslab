import { describe, expect, it } from 'vitest';
import {
  cascadeClaims,
  cascadeEntryNodeIds,
  cascadeExitWords,
  cascadeMemberships,
} from '@/lib/domain/cascadeMembership';
import type { Cascade } from '@/lib/domain/cascades';

type C = Parameters<typeof cascadeMemberships>[0][number];
const pos = (position: number, nodeIds: string[]) => ({ position, nodeIds }) as Cascade['positions'][number];
const dir = (nodeIds: string[], countryCode = '', tag = 1) =>
  ({ nodeIds, countryCode, tag }) as Cascade['directions'][number];
const hop = (nodeId: string, position: number) => ({ nodeId, position }) as Cascade['hops'][number];

// v4 with a pooled entry, one transit and two directions: does not fold into hops.
const v4: C = {
  id: 'c1',
  name: 'first',
  mode: 'balancer',
  hops: [],
  positions: [pos(0, ['x', 'y']), pos(1, ['t'])],
  directions: [dir(['d1'], 'DE', 1), dir([], '', 2)],
};
const old: C = {
  id: 'c2',
  name: 'legacy',
  mode: 'chain',
  hops: [hop('h1', 0), hop('h2', 1), hop('h3', 2)],
  positions: [],
  directions: [],
};

describe('cascadeMemberships (A-144): v4 по позициям и направлениям, хопы запасным', () => {
  it('v4 с hops: [] и пулом входа: роли входа, транзита и выхода', () => {
    const m = cascadeMemberships([v4]);
    expect([...m].map(([id, x]) => [id, x.role, x.cascade.name])).toEqual([
      ['x', 'entry', 'first'],
      ['y', 'entry', 'first'],
      ['t', 'transit', 'first'],
      ['d1', 'exit', 'first'],
    ]);
  });

  it('старый каскад по хопам: вход, транзит, выход', () => {
    const m = cascadeMemberships([old]);
    expect(['h1', 'h2', 'h3'].map((id) => m.get(id)?.role)).toEqual(['entry', 'transit', 'exit']);
  });

  it('нода в двух каскадах: первый в списке держит её, как генератор', () => {
    const second: C = { ...old, id: 'c3', name: 'second', hops: [hop('x', 0)] };
    expect(cascadeMemberships([v4, second]).get('x')?.cascade.name).toBe('first');
  });

  it('вход каскада для «сегодня через каскады»: весь пул входа', () => {
    expect(cascadeEntryNodeIds(v4)).toEqual(['x', 'y']);
    expect(cascadeEntryNodeIds(old)).toEqual(['h1']);
  });

  it('выходы словами: страна направления, иначе страна ноды, иначе тег', () => {
    expect(cascadeExitWords(v4, () => null)).toEqual(['DE', '#2']);
    expect(cascadeExitWords(old, (id) => (id === 'h3' ? 'nl' : null))).toEqual(['NL']);
  });

  it('нода выхода неизвестна (список нод не пришёл): «?», а не пропавший выход; v4 читает свою страну', () => {
    expect(cascadeExitWords(old, () => undefined).every((w) => w === '?')).toBe(true);
    expect(cascadeExitWords(old, () => undefined).length).toBe(cascadeExitWords(old, () => 'de').length);
    expect(cascadeExitWords(v4, () => undefined)).toEqual(['DE', '#2']);
  });
});

describe('cascadeClaims (A-139) на той же функции', () => {
  it('редактируемый каскад своих нод не занимает', () => {
    const m = cascadeClaims([v4, old], 'c1');
    expect(m.has('x')).toBe(false);
    expect(m.get('h1')).toBe('legacy');
  });

  it('направление на именованном выходе без нод ничего не занимает', () => {
    expect(cascadeClaims([{ ...v4, positions: [], directions: [dir([])] }]).size).toBe(0);
  });
});
