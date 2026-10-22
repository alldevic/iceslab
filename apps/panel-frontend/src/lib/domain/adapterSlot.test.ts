import { describe, expect, it } from 'vitest';
import { adapterSlot, adapterSlotRefusal, addOnePerSlot, slotHeldBy, slotShared } from '@/lib/domain/adapterSlot';

const p = (id: string, protocol: string, effectiveEngine: string, awgProtocol?: 1 | 3) => ({
  id,
  name: `n-${id}`,
  protocol,
  effectiveEngine,
  ...(awgProtocol ? { awgProtocol } : {}),
});

describe('adapterSlot (A-055, зеркало node-adapter-slot.ts)', () => {
  it('протокол и движок; AWG по поколению, без поколения это 1.x', () => {
    expect(adapterSlot(p('a', 'hysteria', 'hysteria'))).toBe('hysteria|hysteria');
    expect(adapterSlot(p('a', 'xray', 'singbox'))).toBe('xray|singbox');
    expect(adapterSlot(p('a', 'amneziawg', 'amneziawg', 3))).toBe('amneziawg|3');
    expect(adapterSlot(p('a', 'amneziawg', 'amneziawg'))).toBe('amneziawg|1');
  });

  it('много входов держит только xray на xray', () => {
    expect(slotShared('xray|xray')).toBe(true);
    expect(slotShared('xray|singbox')).toBe(false);
  });
});

describe('мастер не предлагает второй вход того же адаптера', () => {
  const list = [
    p('h1', 'hysteria', 'hysteria'),
    p('h2', 'hysteria', 'hysteria'),
    p('x1', 'xray', 'xray'),
    p('x2', 'xray', 'xray'),
    p('a1', 'amneziawg', 'amneziawg', 1),
    p('a3', 'amneziawg', 'amneziawg', 3),
  ];

  it('выбран h1: h2 занят им; xray на xray и другое поколение AWG свободны', () => {
    const held = slotHeldBy(list, ['h1', 'x1', 'a1']);
    expect([...held]).toEqual([['h2', 'n-h1']]);
  });

  it('«выбрать все» берёт один на адаптер, xray на xray все', () => {
    expect(addOnePerSlot([], list)).toEqual(['h1', 'x1', 'x2', 'a1', 'a3']);
    expect(addOnePerSlot(['h2'], list)).toEqual(['h2', 'x1', 'x2', 'a1', 'a3']);
  });
});

describe('adapterSlotRefusal', () => {
  const res = (status: number, data: unknown) => ({ response: { status, data } });

  it('409 ADAPTER_SLOT_TAKEN: протокол, движок, кто держит, фраза', () => {
    expect(
      adapterSlotRefusal(res(409, { error: 'ADAPTER_SLOT_TAKEN', protocol: 'xray', engine: 'singbox', heldBy: 'First', message: 'm' })),
    ).toEqual({ protocol: 'xray', engine: 'singbox', heldBy: 'First', message: 'm' });
  });

  it('мусор и чужие отказы: null', () => {
    for (const e of [null, 'x', new Error('x'), { response: null }, res(409, { error: 'PORT_TAKEN_PROFILE' }), res(400, { error: 'ADAPTER_SLOT_TAKEN' }), res(409, null)]) {
      expect(adapterSlotRefusal(e)).toBeNull();
    }
  });
});
