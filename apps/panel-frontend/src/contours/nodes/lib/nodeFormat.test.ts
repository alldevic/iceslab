import { describe, expect, it } from 'vitest';
import { bytesOrDash, countOrDash } from '@/contours/nodes/lib/nodeFormat';
import ru from '@/i18n/locales/ru';
import en from '@/i18n/locales/en';

describe('A-261: подпись строки о том же, что значение', () => {
  // The value is the overview's inboundCount = the node's bindings; the
  // label says bindings, not «user reach», which the answer does not carry.
  const at = (d: unknown, key: string) => key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], d);
  it('nodeEdit.bindings: «Привязки» / «Bindings»; userReach снят', () => {
    expect(at(ru, 'nodeEdit.bindings')).toBe('Привязки');
    expect(at(en, 'nodeEdit.bindings')).toBe('Bindings');
    expect(at(ru, 'nodeEdit.userReach')).toBeUndefined();
  });
});

describe('блок «Система» ноды: числа или «-»', () => {
  it('без dashNode обе строки «-»', () => {
    const dashNode = undefined as { todayBytes: number; inboundCount: number } | undefined;
    expect([bytesOrDash(dashNode?.todayBytes), countOrDash(dashNode?.inboundCount)]).toEqual(['-', '-']);
  });
  it('число привязок: неотрицательное число как есть, -1, нет ответа и мусор это «-»', () => {
    expect(countOrDash(3)).toBe('3');
    expect(countOrDash(0)).toBe('0');
    for (const v of [-1, undefined, null, Number.NaN, Infinity, '3']) expect(countOrDash(v)).toBe('-');
  });
  it('трафик за сегодня: без ответа «-», а не «0 B»; ноль от сервера это ноль', () => {
    expect(bytesOrDash(undefined)).toBe('-');
    expect(bytesOrDash(-5)).toBe('-');
    expect(bytesOrDash(0)).toBe('0 B');
    expect(bytesOrDash(2048)).toBe('2.0 KiB');
  });
});
