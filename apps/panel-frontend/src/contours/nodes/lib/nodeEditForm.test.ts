import { describe, expect, it } from 'vitest';
import { defaults, egressOf, statusPut } from '@/contours/nodes/lib/nodeEditForm';
import type { Node } from '@/lib/domain/nodes';

describe('egressOf (spec frontend-nodes п.1)', () => {
  it('нода в каскаде: каскад, что бы ни стояло в WARP', () => {
    expect(egressOf(true, true, true)).toBe('cascade');
    expect(egressOf(true, true, false)).toBe('cascade');
  });

  it('список каскадов не пришёл: неизвестно, а не «напрямую» и не WARP', () => {
    expect(egressOf(false, false, false)).toBe('unknown');
    expect(egressOf(false, false, true)).toBe('unknown');
  });

  it('список пришёл, ноды в нём нет: WARP или напрямую по ноде', () => {
    expect(egressOf(false, true, true)).toBe('warp');
    expect(egressOf(false, true, false)).toBe('direct');
  });
});

describe('statusPut («В работе»)', () => {
  it('шлёт статус, только когда переключатель сдвинут против сохранённого', () => {
    expect(statusPut({ status: 'online' }, true)).toEqual({});
    expect(statusPut({ status: 'disabled' }, false)).toEqual({});
    expect(statusPut({ status: 'unreachable' }, false)).toEqual({ status: 'disabled' });
    expect(statusPut({ status: 'disabled' }, true)).toEqual({ status: 'active' });
    expect(statusPut(null, false)).toEqual({});
  });

  it('форма читает disabled как «не в работе», остальное как «в работе»', () => {
    expect(defaults({ status: 'disabled', address: 'a:1' } as Node).inService).toBe(false);
    expect(defaults({ status: 'degraded', address: 'a:1' } as Node).inService).toBe(true);
  });
});
