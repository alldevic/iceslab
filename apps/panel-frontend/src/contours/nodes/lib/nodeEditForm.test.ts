import { describe, expect, it } from 'vitest';
import type { NodeCores } from '@iceslab/shared';
import type { Node } from '@/lib/domain/nodes';
import { nodeIpv6ModeNote } from '@/contours/nodes/lib/nodeAdapterFacts';
import { addressFromForm, domainOk, defaults, domainPatch, egressOf, ipv6ModePatch, nodeHostOk, splitAddress, statusPut } from '@/contours/nodes/lib/nodeEditForm';

describe('домен ноды в PUT (A-057)', () => {
  it('уходит только изменённый; пустое снимает домен null', () => {
    expect(domainPatch(null, 'node.example.com')).toEqual({ domain: 'node.example.com' });
    expect(domainPatch(null, '  node.example.com ')).toEqual({ domain: 'node.example.com' });
    expect(domainPatch('node.example.com', 'node.example.com')).toEqual({});
    expect(domainPatch('node.example.com', 'other.example.com')).toEqual({ domain: 'other.example.com' });
    expect(domainPatch('node.example.com', '  ')).toEqual({ domain: null });
    expect(domainPatch(null, '')).toEqual({});
    expect(domainPatch(undefined, '')).toEqual({});
  });

  it('форма проверяет то же, что схема сервера: голое имя хоста до 255', () => {
    expect(domainOk('')).toBe(true);
    expect(domainOk('node-1.example.com')).toBe(true);
    for (const bad of ['https://node.example.com', 'node.example.com:443', 'node example.com', 'нода.рф', 'a'.repeat(256)]) {
      expect(domainOk(bad)).toBe(false);
    }
  });
});

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

describe('адрес ноды в форме: IPv6', () => {
  it('splitAddress читает все записи, хост без скобок', () => {
    expect(splitAddress('node.example.com')).toEqual({ host: 'node.example.com', port: 1337 });
    expect(splitAddress('203.0.113.7:2600')).toEqual({ host: '203.0.113.7', port: 2600 });
    expect(splitAddress('2001:db8::1')).toEqual({ host: '2001:db8::1', port: 1337 });
    expect(splitAddress('[2001:db8::1]:2600')).toEqual({ host: '2001:db8::1', port: 2600 });
  });

  it('поле хоста принимает имя, IPv4, IPv6 с скобками и без; порт и схему не принимает', () => {
    for (const ok of ['node.example.com', '203.0.113.7', '2001:db8::1', '[2001:db8::1]', '2001:DB8:0:0:0:0:0:1']) {
      expect(nodeHostOk(ok), ok).toBe(true);
    }
    for (const bad of ['node.example.com:1337', '[2001:db8::1]:1337', 'https://a.example', '2001:db8::zz', 'a b', '']) {
      expect(nodeHostOk(bad), bad).toBe(false);
    }
  });

  it('адрес из формы: порт после скобок у IPv6, прежняя строка у имени и IPv4', () => {
    expect(addressFromForm('node.example.com', 1337)).toBe('node.example.com:1337');
    expect(addressFromForm(' 203.0.113.7 ', 2600)).toBe('203.0.113.7:2600');
    expect(addressFromForm('2001:db8::1', 1337)).toBe('[2001:db8::1]:1337');
    expect(addressFromForm('[2001:db8::1]', 2600)).toBe('[2001:db8::1]:2600');
  });

  it('форма правки показывает IPv6 ноды и собирает его обратно в тот же адрес', () => {
    const form = defaults({ address: '2001:db8::1' } as Node);
    expect(form.host).toBe('2001:db8::1');
    expect(form.port).toBe(1337);
    expect(addressFromForm(form.host, Number(form.port))).toBe('[2001:db8::1]:1337');
  });
});

describe('режим IPv6 ноды (18.6)', () => {
  it('в форме читается из ноды; нет значения (сервер старше поля) или чужое значение — auto', () => {
    expect(defaults({ ipv6Mode: 'off' } as Node).ipv6Mode).toBe('off');
    expect(defaults({ ipv6Mode: 'on' } as Node).ipv6Mode).toBe('on');
    expect(defaults({} as Node).ipv6Mode).toBe('auto');
    expect(defaults({ ipv6Mode: 'x' } as unknown as Node).ipv6Mode).toBe('auto');
    expect(defaults(null).ipv6Mode).toBe('auto');
  });

  it('в PUT уходит только изменённый', () => {
    expect(ipv6ModePatch('auto', 'auto')).toEqual({});
    expect(ipv6ModePatch(undefined, 'auto')).toEqual({});
    expect(ipv6ModePatch('off', 'off')).toEqual({});
    expect(ipv6ModePatch('auto', 'off')).toEqual({ ipv6Mode: 'off' });
    expect(ipv6ModePatch(undefined, 'on')).toEqual({ ipv6Mode: 'on' });
    expect(ipv6ModePatch('on', 'auto')).toEqual({ ipv6Mode: 'auto' });
  });

  const cores = (ipv6?: NodeCores['ipv6']): NodeCores => ({ observedAt: 't', cores: [], ...(ipv6 ? { ipv6 } : {}) });
  const works = { stack: true, global: true, addresses: ['2001:db8::1'], egress: true };
  const fails = { stack: true, global: true, addresses: ['2001:db8::1'], egress: false };
  const none = { stack: false, global: false, addresses: [] as string[] };

  it('пометки: on при неуспешной проверке — «может не работать»; агент без блока ipv6 — не поддерживает', () => {
    expect(nodeIpv6ModeNote(cores(fails), 'on')).toBe('onNotWorking');
    expect(nodeIpv6ModeNote(cores(none), 'on')).toBe('onNotWorking');
    expect(nodeIpv6ModeNote(cores(works), 'on')).toBeNull();
    expect(nodeIpv6ModeNote(cores(fails), 'off')).toBeNull();
    expect(nodeIpv6ModeNote(cores(fails), 'auto')).toBeNull();
    expect(nodeIpv6ModeNote(cores(), 'on')).toBe('agentUnsupported');
    expect(nodeIpv6ModeNote(cores(), 'off')).toBe('agentUnsupported');
    expect(nodeIpv6ModeNote(null, 'on')).toBe('agentUnsupported');
    expect(nodeIpv6ModeNote(cores(), 'auto')).toBeNull();
  });
});
