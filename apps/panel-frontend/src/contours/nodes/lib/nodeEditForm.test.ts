import { describe, expect, it } from 'vitest';
import { egressOf } from '@/contours/nodes/lib/nodeEditForm';

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
