import { describe, expect, it } from 'vitest';
import { MULTI_INBOUND_ADAPTERS } from '@iceslab/shared';
import { adapterRefusal, adapterRefusalWords, addOnePerSlot, slotHeldBy, slotShared } from '@/lib/domain/adapterSlot';

const p = (id: string, protocol: string, engine: string | null, awgProtocol?: 1 | 3) => ({
  id,
  name: `n-${id}`,
  protocol,
  engine,
  ...(awgProtocol ? { awgProtocol } : {}),
});

describe('общий слот читается из @iceslab/shared (A-196)', () => {
  // The list moves as the agent learns multi-inbound per adapter (f4dc7aa8
  // added the six sing-box protocols): the screen follows the contract, so
  // the test checks the reading, not a copy of today's list.
  it('slotShared отвечает ровно по MULTI_INBOUND_ADAPTERS', () => {
    for (const slot of ['xray|xray', 'mieru|mieru', 'xray|singbox', 'hysteria|hysteria', 'amneziawg|1', 'naive|naive']) {
      expect(slotShared(slot)).toBe(MULTI_INBOUND_ADAPTERS.includes(slot));
    }
    expect(slotShared('xray|xray')).toBe(true);
  });
});

describe('мастер не предлагает второй вход того же адаптера', () => {
  const list = [
    p('h1', 'hysteria', null),
    p('h2', 'hysteria', null),
    p('x1', 'xray', null),
    p('x2', 'xray', null),
    p('m1', 'mieru', null),
    p('m2', 'mieru', null),
    p('a1', 'amneziawg', null, 1),
    p('a3', 'amneziawg', null, 3),
  ];

  it('выбран h1: h2 занят им; xray, mieru и другое поколение AWG свободны', () => {
    expect([...slotHeldBy(list, ['h1', 'x1', 'm1', 'a1'])]).toEqual([['h2', 'n-h1']]);
  });

  it('«выбрать все» берёт один на адаптер, общие адаптеры все', () => {
    expect(addOnePerSlot([], list)).toEqual(['h1', 'x1', 'x2', 'm1', 'm2', 'a1', 'a3']);
    expect(addOnePerSlot(['h2'], list)).toEqual(['h2', 'x1', 'x2', 'm1', 'm2', 'a1', 'a3']);
  });
});

describe('adapterRefusal', () => {
  const res = (status: number, data: unknown) => ({ response: { status, data } });
  const t = (k: string, o?: Record<string, unknown>) => `${k}${o ? JSON.stringify(o) : ''}`;

  it('ADAPTER_SLOT_TAKEN: с нодой и без', () => {
    expect(adapterRefusal(res(409, { error: 'ADAPTER_SLOT_TAKEN', protocol: 'xray', engine: 'singbox', heldBy: 'First' }))).toEqual({
      kind: 'slot',
      nodeName: null,
      protocol: 'xray',
      engine: 'singbox',
      heldBy: 'First',
    });
    expect(
      adapterRefusal(res(409, { error: 'ADAPTER_SLOT_TAKEN', nodeName: 'de-1', protocol: 'hysteria', engine: 'hysteria', heldBy: 'A' }))
        ?.nodeName,
    ).toBe('de-1');
  });

  it('MIERU_MTU_MISMATCH: MTU стоящий и желаемый', () => {
    expect(adapterRefusal(res(409, { error: 'MIERU_MTU_MISMATCH', nodeName: 'n', mtu: 1400, wanted: 1280, heldBy: 'M' }))).toEqual({
      kind: 'mtu',
      nodeName: 'n',
      mtu: 1400,
      wanted: 1280,
      heldBy: 'M',
    });
  });

  it('слова: нода впереди, когда сервер её назвал', () => {
    const w = adapterRefusalWords({ kind: 'mtu', nodeName: 'n', mtu: 1400, wanted: 1280, heldBy: 'M' }, t);
    expect(w.startsWith('hostEdit.onNode')).toBe(true);
    expect(w).toContain('hostEdit.mieruMtuMismatch');
    expect(adapterRefusalWords({ kind: 'slot', nodeName: null, protocol: 'p', engine: 'e', heldBy: 'h' }, t)).toMatch(/^hostEdit\.adapterSlotTaken/);
  });

  it('мусор и чужие отказы: null', () => {
    for (const e of [null, 'x', new Error('x'), { response: null }, res(409, { error: 'PORT_TAKEN_PROFILE' }), res(400, { error: 'ADAPTER_SLOT_TAKEN' }), res(409, null)]) {
      expect(adapterRefusal(e)).toBeNull();
    }
  });
});
