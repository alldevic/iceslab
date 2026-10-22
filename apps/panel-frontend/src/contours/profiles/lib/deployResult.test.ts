import { describe, expect, it } from 'vitest';
import { deployOutcome } from '@/contours/profiles/lib/deployResult';

const ok = (v: unknown = null): PromiseSettledResult<unknown> => ({ status: 'fulfilled', value: v });
const no = (reason: unknown): PromiseSettledResult<unknown> => ({ status: 'rejected', reason });
const res = (status: number, data: unknown) => ({ response: { status, data } });

describe('deployOutcome (хвост A-055)', () => {
  it('отказ по адаптеру встаёт у той ноды, для которой слали; остальное стоит', () => {
    const o = deployOutcome(
      ['n1', 'n2', 'n3'],
      [ok(), no(res(409, { error: 'ADAPTER_SLOT_TAKEN', protocol: 'hysteria', engine: 'hysteria', heldBy: 'A' })), no(res(409, { error: 'MIERU_MTU_MISMATCH', nodeName: 'n3', mtu: 1400, wanted: 1280, heldBy: 'M' }))],
      [ok()],
    );
    expect(o.created).toBe(1);
    expect(o.deleted).toBe(1);
    expect([...o.refused.keys()]).toEqual(['n2', 'n3']);
    expect(o.refused.get('n2')?.kind).toBe('slot');
    expect(o.refused.get('n3')?.kind).toBe('mtu');
    expect(o.other).toBeNull();
  });

  it('чужой отказ уходит в other первым, без потери адаптерных', () => {
    const port = res(409, { error: 'PORT_TAKEN_PROFILE', conflicts: [] });
    const o = deployOutcome(['n1', 'n2'], [no(port), no(res(409, { error: 'ADAPTER_SLOT_TAKEN', heldBy: 'A' }))], [no(new Error('x'))]);
    expect(o.other).toBe(port);
    expect(o.refused.has('n2')).toBe(true);
    expect(o.created).toBe(0);
    expect(o.deleted).toBe(0);
  });
});
